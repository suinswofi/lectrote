'use strict';

const electron = require('electron');
const audioconfig = require('./audioconfig.js');

/* This module is loaded in the game process (see apphooks.js). It
   handles the game-window side of the speech features:

   - Text-to-speech: every game turn, we pull the new story text out of
     the GlkOte update (via the recording handler) and send it to the
     main process, which hands it to the audio engine. Audio comes back
     one sentence at a time and we play it through Web Audio.

   - Speech-to-text: while the push-to-talk key is held, we record from
     the microphone; on release we resample to 16 kHz and send the
     audio off for transcription. The resulting text goes into the
     game's input field (and is submitted, if the pref says so).

   The audio engine itself lives in a utility process; see main.js and
   audioengine.js. This module never touches the models directly.

   This assumes that the document has a #audiobar div (with the
   .CanHaveInputFocus class), which we fill in with a small status
   display and a microphone button.
*/

/* Set LECTROTE_AUDIO_DEBUG=1 in the environment to trace the speech
   traffic in the console. */
const debug = (process.env.LECTROTE_AUDIO_DEBUG ? function() { console.log.apply(console, ['speech:'].concat(Array.from(arguments))); } : function() {});

/* Prefs, as sent by main.js (audio_prefs_for_renderer). */
var prefs = null;
/* Engine status, as sent by main.js (audio_status). */
var status = { tts:{ status:'unloaded' }, stt:{ status:'unloaded' } };

/* A random token for this page load, so that speech chunks from a
   previous incarnation of the page (before a game reset) can be
   recognized and dropped. */
const page_token = Math.random().toString(36).slice(2, 10);
var job_counter = 0;

/* --- TTS state --- */
var last_turn_text = null;   /* for "Repeat Last Turn" */
var pending_text = null;     /* text waiting for the model to finish loading */
var current_jobid = null;    /* the speech job we're playing (or null) */
var play_ctx = null;         /* AudioContext for playback */
var play_next_time = 0;      /* when the next chunk should start */
var play_sources = [];       /* AudioBufferSourceNodes in flight */
var os_utterance = null;     /* SpeechSynthesisUtterance in flight (fallback) */

/* --- STT state --- */
var mic_stream = null;       /* MediaStream from getUserMedia */
var mic_ctx = null;          /* AudioContext for capture */
var mic_node = null;         /* AudioWorkletNode or ScriptProcessorNode */
var mic_acquiring = null;    /* promise while getUserMedia is in flight */
var listening = false;       /* currently recording */
var listen_toggle_mode = false; /* recording was started by the toggle command, not a held key */
var listen_chunks = [];      /* Float32Array pieces at mic_ctx.sampleRate */
var listen_samples = 0;
var listen_timer = null;     /* auto-stop timer */
var listen_level = 0;        /* recent RMS, for the meter */
var current_reqid = null;    /* transcription request in flight */
var status_timer = null;     /* timer to clear a transient status message */

/* --- Audiobar elements --- */
var bar_el = null;
var bar_icon_el = null;
var bar_text_el = null;
var bar_meter_el = null;
var bar_mic_el = null;

/* Text extraction from a GlkOte update.

   The stanza is what GlkOte hands to the recording handler: { input,
   output, ... }. This is essentially the same walk as traread.js
   (stanzas_write_to_file) but building a string for speech: only
   buffer windows count (grid windows -- the status line -- have
   "lines" rather than "text"), the echoed player command is skipped,
   and images become their alt text.
*/
function extract_speech_text(obj)
{
    if (!obj || !obj.output || !obj.output.content)
        return '';

    var paras = [];  /* list of paragraph strings */
    var cur = null;  /* current paragraph, or null */

    function flush()
    {
        if (cur !== null) {
            var val = cur.replace(/\s+/g, ' ').trim();
            if (val.length)
                paras.push(val);
        }
        cur = null;
    }

    for (var dat of obj.output.content) {
        if (!dat.text)
            continue;
        if (dat.clear) {
            flush();
        }
        for (var ix=0; ix<dat.text.length; ix++) {
            var textarg = dat.text[ix];
            var content = textarg.content;
            if (!textarg.append) {
                flush();
            }
            if (!content || !content.length)
                continue;
            if (cur === null)
                cur = '';
            for (var sx=0; sx<content.length; sx++) {
                var rdesc = content[sx];
                var rstyle, rtext;
                if (!(typeof rdesc === 'string' || rdesc instanceof String)) {
                    if (rdesc.special !== undefined) {
                        if (rdesc.special == 'image' && rdesc.alttext) {
                            cur += ' ' + rdesc.alttext + ' ';
                        }
                        continue;
                    }
                    rstyle = rdesc.style;
                    rtext = rdesc.text;
                }
                else {
                    rstyle = rdesc;
                    sx++;
                    rtext = content[sx];
                }
                if (rstyle == 'input') {
                    /* The player's own command, echoed back. */
                    continue;
                }
                if (rtext)
                    cur += rtext;
            }
        }
    }
    flush();

    /* Drop bare prompt characters and paragraphs with nothing
       pronounceable in them. */
    var res = [];
    for (var para of paras) {
        para = para.replace(/^>+\s*/, '').replace(/\s*>+$/, '');
        if (!/[A-Za-z0-9]/.test(para))
            continue;
        res.push(para);
    }
    var text = res.join('\n');
    if (text.length > audioconfig.speech_max_chars) {
        text = text.slice(0, audioconfig.speech_max_chars) + '\nThe rest of this text has been cut off.';
    }
    return text;
}

/* Called (via apphooks.js) by the GlkOte recording handler for every
   game turn.
*/
function record_update(obj)
{
    var text = extract_speech_text(obj);

    if (prefs && prefs.tts_speak_input && obj.input && obj.input.type == 'line' && obj.input.value) {
        var val = String(obj.input.value).trim();
        if (val.length) {
            text = val + '.\n' + text;
        }
    }

    if (!text.length)
        return;

    debug('turn text (' + text.length + ' chars):', JSON.stringify(text.slice(0, 120)));
    last_turn_text = text;
    if (prefs && prefs.tts_enabled) {
        speak(text);
    }
}

/* --- Text-to-speech playback --- */

function speak(text)
{
    stop_playback();

    if (status.tts.status == 'ready') {
        job_counter++;
        current_jobid = page_token + '-' + job_counter;
        debug('speak job', current_jobid);
        electron.ipcRenderer.send('speech_speak', { jobid:current_jobid, text:text });
        set_bar_state('speaking');
        return;
    }

    if (status.tts.status == 'loading' || status.tts.status == 'unloaded') {
        /* The model is on its way (a cached model loads in a second or
           so, and the engine is started as soon as the app launches).
           Hold the text and speak it when it's ready. */
        debug('tts ' + status.tts.status + '; holding text');
        pending_text = text;
        update_bar();
        return;
    }

    /* The Kokoro model isn't ready and won't be soon (it's downloading,
       or failed). Fall back to the system voice, if the user allows it. */
    debug('tts not ready (' + status.tts.status + '); fallback=' + prefs.tts_fallback_os);
    if (prefs.tts_fallback_os && window.speechSynthesis) {
        try {
            var utter = new SpeechSynthesisUtterance(text);
            utter.rate = prefs.tts_speed || 1.0;
            utter.onend = function() {
                if (os_utterance === utter) {
                    os_utterance = null;
                    update_bar();
                }
            };
            utter.onerror = utter.onend;
            os_utterance = utter;
            window.speechSynthesis.speak(utter);
            set_bar_state('speaking');
        }
        catch (ex) {
            os_utterance = null;
        }
    }
}

/* Stop whatever is being spoken, and tell the engine to stop generating
   for us.
*/
function stop_playback()
{
    var wasplaying = (current_jobid !== null || os_utterance !== null || play_sources.length > 0);

    pending_text = null;

    if (current_jobid !== null) {
        current_jobid = null;
        electron.ipcRenderer.send('speech_stop');
    }

    for (var src of play_sources) {
        try {
            src.onended = null;
            src.stop();
        }
        catch (ex) {}
    }
    play_sources = [];
    play_next_time = 0;

    if (os_utterance !== null) {
        os_utterance = null;
        try {
            window.speechSynthesis.cancel();
        }
        catch (ex) {}
    }

    if (wasplaying)
        update_bar();
}

/* A sentence of audio has arrived from the engine. */
function on_speech_audio(chunk)
{
    if (!chunk || chunk.jobid !== current_jobid) {
        debug('dropping stale audio chunk', chunk && chunk.jobid);
        return;
    }
    debug('audio chunk', chunk.jobid, chunk.seq, chunk.audio && chunk.audio.length, JSON.stringify(chunk.text));

    var audio = chunk.audio;
    if (!(audio instanceof Float32Array)) {
        try {
            audio = new Float32Array(audio.buffer, audio.byteOffset, audio.byteLength / 4);
        }
        catch (ex) {
            return;
        }
    }
    if (!audio.length)
        return;

    var rate = chunk.sample_rate || audioconfig.tts_model.sample_rate;
    if (!play_ctx) {
        play_ctx = new AudioContext({ sampleRate:rate });
    }
    if (play_ctx.state == 'suspended') {
        play_ctx.resume();
    }

    var buf = play_ctx.createBuffer(1, audio.length, rate);
    buf.copyToChannel(audio, 0);
    var src = play_ctx.createBufferSource();
    src.buffer = buf;
    src.connect(play_ctx.destination);

    var now = play_ctx.currentTime;
    var startat = Math.max(now + 0.02, play_next_time);
    src.start(startat);
    play_next_time = startat + buf.duration;
    play_sources.push(src);
    src.onended = function() {
        var pos = play_sources.indexOf(src);
        if (pos >= 0)
            play_sources.splice(pos, 1);
        update_bar();
    };
    set_bar_state('speaking');
}

/* The engine has finished (or abandoned) a speech job. Playback of the
   already-delivered chunks continues on its own. */
function on_speech_done(arg)
{
    if (!arg || arg.jobid !== current_jobid)
        return;
    current_jobid = null;
    update_bar();
}

function repeat_last()
{
    if (!prefs || !prefs.tts_enabled)
        return;
    if (last_turn_text)
        speak(last_turn_text);
}

/* --- Speech-to-text: microphone capture --- */

/* The AudioWorklet processor which ships raw samples back to us. We
   load it from a blob: URL so there's no separate file to package. */
const capture_worklet_source = `
class LectroteCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buf = new Float32Array(4096);
        this.pos = 0;
    }
    process(inputs, outputs) {
        const input = inputs[0];
        if (input && input[0]) {
            const data = input[0];
            let ix = 0;
            while (ix < data.length) {
                const take = Math.min(data.length - ix, this.buf.length - this.pos);
                this.buf.set(data.subarray(ix, ix + take), this.pos);
                this.pos += take;
                ix += take;
                if (this.pos == this.buf.length) {
                    this.port.postMessage(this.buf);
                    this.buf = new Float32Array(4096);
                    this.pos = 0;
                }
            }
        }
        return true;
    }
}
registerProcessor('lectrote-capture', LectroteCapture);
`;

/* Get hold of the microphone (once) and set up the capture graph. The
   graph runs continuously while we hold the stream; the "listening"
   flag decides whether samples are kept.
*/
async function acquire_mic()
{
    if (mic_stream)
        return true;
    if (mic_acquiring)
        return mic_acquiring;

    mic_acquiring = (async function() {
        try {
            var stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true },
                video: false
            });
            var ctx = new AudioContext();
            var source = ctx.createMediaStreamSource(stream);
            var node = null;
            try {
                var blob = new Blob([capture_worklet_source], { type:'application/javascript' });
                var url = URL.createObjectURL(blob);
                await ctx.audioWorklet.addModule(url);
                URL.revokeObjectURL(url);
                node = new AudioWorkletNode(ctx, 'lectrote-capture', { numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[1] });
                node.port.onmessage = function(ev) {
                    on_mic_samples(ev.data);
                };
            }
            catch (ex) {
                console.log('speech: AudioWorklet unavailable, using ScriptProcessorNode:', ex);
                node = ctx.createScriptProcessor(4096, 1, 1);
                node.onaudioprocess = function(ev) {
                    on_mic_samples(new Float32Array(ev.inputBuffer.getChannelData(0)));
                };
            }
            /* The node must be wired through to the destination to be
               rendered at all; a zero-gain node keeps it silent. */
            var gain = ctx.createGain();
            gain.gain.value = 0;
            source.connect(node);
            node.connect(gain);
            gain.connect(ctx.destination);

            mic_stream = stream;
            mic_ctx = ctx;
            mic_node = node;
            return true;
        }
        catch (ex) {
            console.log('speech: microphone unavailable:', ex);
            var msg = 'Microphone unavailable';
            if (ex && (ex.name == 'NotAllowedError' || ex.name == 'PermissionDeniedError'))
                msg = 'Microphone access was denied';
            else if (ex && ex.name == 'NotFoundError')
                msg = 'No microphone found';
            show_transient(msg, 4000, 'error');
            return false;
        }
        finally {
            mic_acquiring = null;
        }
    })();
    return mic_acquiring;
}

function release_mic()
{
    if (listening)
        stop_listening(true);
    if (mic_node) {
        try {
            mic_node.disconnect();
        }
        catch (ex) {}
        mic_node = null;
    }
    if (mic_ctx) {
        try {
            mic_ctx.close();
        }
        catch (ex) {}
        mic_ctx = null;
    }
    if (mic_stream) {
        for (var track of mic_stream.getTracks()) {
            try {
                track.stop();
            }
            catch (ex) {}
        }
        mic_stream = null;
    }
}

function on_mic_samples(data)
{
    if (!listening)
        return;
    var arr = (data instanceof Float32Array) ? data : new Float32Array(data);
    listen_chunks.push(arr);
    listen_samples += arr.length;

    var sum = 0;
    for (var ix=0; ix<arr.length; ix++)
        sum += arr[ix] * arr[ix];
    listen_level = Math.sqrt(sum / arr.length);
    update_meter();

    if (mic_ctx && listen_samples > audioconfig.ptt_max_seconds * mic_ctx.sampleRate) {
        stop_listening(false);
    }
}

/* Start recording. (Called on push-to-talk key down, mic button down,
   or the listen-toggle command.)
*/
async function start_listening(toggle)
{
    if (!prefs || !prefs.stt_enabled)
        return;
    if (listening)
        return;

    if (status.stt.status != 'ready') {
        var msg = 'Speech recognition is not ready';
        if (status.stt.status == 'downloading')
            msg = 'Still downloading the speech model (' + (status.stt.pct || 0) + '%)';
        else if (status.stt.status == 'loading')
            msg = 'Still loading the speech model';
        else if (status.stt.status == 'error')
            msg = 'Speech recognition failed to load';
        show_transient(msg, 2500, 'error');
        return;
    }

    /* Don't record our own voice. */
    stop_playback();

    var ok = await acquire_mic();
    if (!ok || listening)
        return;
    if (!prefs.stt_enabled)
        return;

    if (mic_ctx.state == 'suspended') {
        try {
            await mic_ctx.resume();
        }
        catch (ex) {}
    }

    listening = true;
    listen_toggle_mode = (toggle == true);
    listen_chunks = [];
    listen_samples = 0;
    listen_level = 0;
    current_reqid = null;
    set_bar_state('listening');

    listen_timer = setTimeout(function() {
        listen_timer = null;
        if (listening)
            stop_listening(false);
    }, audioconfig.ptt_max_seconds * 1000);
}

/* Stop recording. Unless discard is set, ship the audio off for
   transcription.
*/
function stop_listening(discard)
{
    if (!listening)
        return;
    listening = false;
    listen_toggle_mode = false;
    if (listen_timer) {
        clearTimeout(listen_timer);
        listen_timer = null;
    }

    var chunks = listen_chunks;
    var samples = listen_samples;
    listen_chunks = [];
    listen_samples = 0;
    listen_level = 0;

    if (discard || !mic_ctx) {
        update_bar();
        return;
    }

    var rate = mic_ctx.sampleRate;
    if (samples < audioconfig.ptt_min_seconds * rate) {
        /* (A quick tap of a bare-modifier talk key is probably just a
           shortcut; don't nag about it.) */
        var spec = ptt_spec();
        if (!(spec && spec.modifier))
            show_transient('Too short — hold the key while you speak', 2000, null);
        else
            update_bar();
        return;
    }

    var pcm = new Float32Array(samples);
    var pos = 0;
    for (var chunk of chunks) {
        pcm.set(chunk, pos);
        pos += chunk.length;
    }

    set_bar_state('transcribing');
    resample_and_send(pcm, rate).catch(function(ex) {
        console.log('speech: resample failed:', ex);
        show_transient('Could not process the recording', 3000, 'error');
    });
}

async function resample_and_send(pcm, rate)
{
    var target = audioconfig.stt_sample_rate;
    var outlen = Math.ceil(pcm.length * target / rate);
    var offline = new OfflineAudioContext(1, outlen, target);
    var buf = offline.createBuffer(1, pcm.length, rate);
    buf.copyToChannel(pcm, 0);
    var src = offline.createBufferSource();
    src.buffer = buf;
    src.connect(offline.destination);
    src.start(0);
    var rendered = await offline.startRendering();
    var out = rendered.getChannelData(0);
    /* Copy, so we don't hand over a view into the AudioBuffer. */
    var audio = new Float32Array(out.length);
    audio.set(out);

    job_counter++;
    current_reqid = page_token + '-r' + job_counter;
    electron.ipcRenderer.send('speech_transcribe', { reqid:current_reqid, audio:audio, duration:(audio.length / target) });
}

/* A transcription came back. */
function on_speech_result(arg)
{
    if (!arg || arg.reqid !== current_reqid)
        return;
    current_reqid = null;

    var text = normalize_transcript(arg.text);
    if (!text.length) {
        show_transient('Didn’t catch that', 2500, null);
        return;
    }
    inject_input(text);
}

function on_speech_stt_error(arg)
{
    if (!arg || arg.reqid !== current_reqid)
        return;
    current_reqid = null;
    show_transient('Speech recognition failed: ' + (arg.error || 'unknown error'), 4000, 'error');
}

function normalize_transcript(text)
{
    if (!text)
        return '';
    text = String(text).replace(/\s+/g, ' ').trim();
    /* Whisper likes to punctuate; parsers don't. */
    text = text.replace(/[.!?]+$/, '').trim();
    return text;
}

const spoken_digits = {
    'zero':'0', 'one':'1', 'two':'2', 'to':'2', 'too':'2', 'three':'3', 'four':'4', 'for':'4',
    'five':'5', 'six':'6', 'seven':'7', 'eight':'8', 'nine':'9'
};
const spoken_return = {
    'enter':true, 'return':true, 'continue':true, 'next':true, 'okay':true, 'ok':true,
    'go on':true, 'go':true, 'press any key':true, 'any key':true, 'more':true, 'proceed':true
};

/* Put the recognized text into the game's input field. For line input,
   set the field's value and (optionally) submit it by faking the Enter
   keypress that GlkOte listens for. For character input, pick a single
   key.
*/
function inject_input(text)
{
    var lineel = $('#windowport .WindowFrame.HasInputField input.LineInput').filter(':enabled').first();
    if (!lineel.length)
        lineel = $('#windowport input.LineInput').filter(':enabled').first();

    if (lineel.length) {
        var maxlen = parseInt(lineel.attr('maxlength'));
        var val = text;
        if (maxlen && val.length > maxlen)
            val = val.slice(0, maxlen);
        lineel.val(val);
        lineel.focus();
        show_transient('Heard: “' + val + '”', 2500, null);
        if (prefs.stt_auto_submit) {
            var ev = $.Event('keypress', { which:13, keyCode:13 });
            lineel.trigger(ev);
        }
        return;
    }

    var charel = $('#windowport .WindowFrame.HasInputField input.CharInput').filter(':enabled').first();
    if (charel.length) {
        var lower = text.toLowerCase();
        var code = null;
        var label = null;
        if (spoken_digits[lower] !== undefined) {
            code = spoken_digits[lower].charCodeAt(0);
            label = spoken_digits[lower];
        }
        else if (spoken_return[lower]) {
            code = 13;
            label = 'Enter';
        }
        else if (lower == 'space' || lower == 'space bar') {
            code = 32;
            label = 'Space';
        }
        else if (/^[a-z0-9]$/.test(lower)) {
            code = lower.charCodeAt(0);
            label = lower;
        }
        else if (/^[a-z]+$/.test(lower)) {
            /* A single word ("yes", "no", "quit"): use its first letter. */
            code = lower.charCodeAt(0);
            label = lower[0];
        }
        else {
            code = 13;
            label = 'Enter';
        }
        show_transient('Heard: “' + text + '” → ' + label, 2500, null);
        charel.focus();
        var ev = $.Event('keypress', { which:code, keyCode:code });
        charel.trigger(ev);
        return;
    }

    show_transient('Heard: “' + text + '” — but the game isn’t waiting for input', 3500, null);
}

/* The push-to-talk key: window-level, capture phase, so GlkOte never
   sees it. The key spec comes from audioconfig (or the custom pref);
   see ptt_spec_for_prefs(). */
function ptt_spec()
{
    return audioconfig.ptt_spec_for_prefs(prefs);
}

function ptt_matches_down(ev)
{
    if (!prefs || !prefs.stt_enabled)
        return false;
    var spec = ptt_spec();
    if (!spec || !spec.codes || spec.codes.indexOf(ev.code) < 0)
        return false;
    if (spec.modifier) {
        /* A bare modifier key (hold Ctrl). Its own flag is set on its
           keydown; ignore the others. */
        return true;
    }
    if ((ev.ctrlKey == true) != (spec.ctrl == true))
        return false;
    if ((ev.altKey == true) != (spec.alt == true))
        return false;
    if ((ev.shiftKey == true) != (spec.shift == true))
        return false;
    if ((ev.metaKey == true) != (spec.meta == true))
        return false;
    return true;
}

/* On key-up we're looser: releasing either the key or any of its
   modifiers ends the recording. */
function ptt_matches_up(ev)
{
    if (!listening || listen_toggle_mode)
        return false;
    var spec = ptt_spec();
    if (!spec || !spec.codes)
        return false;
    if (spec.codes.indexOf(ev.code) >= 0)
        return true;
    if (spec.modifier)
        return false;
    if (spec.ctrl && ev.key == 'Control')
        return true;
    if (spec.alt && ev.key == 'Alt')
        return true;
    if (spec.shift && ev.key == 'Shift')
        return true;
    if (spec.meta && ev.key == 'Meta')
        return true;
    return false;
}

function evhan_keydown(ev)
{
    if (!ptt_matches_down(ev)) {
        /* If the talk key is a bare modifier and another key is pressed
           while it's held, the player is typing a shortcut (Ctrl+C), not
           talking. Drop the recording and let the key through. */
        if (listening && !listen_toggle_mode) {
            var spec = ptt_spec();
            if (spec && spec.modifier && !ev.repeat)
                stop_listening(true);
        }
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.repeat)
        return;
    if (listening && listen_toggle_mode) {
        stop_listening(false);
        return;
    }
    start_listening(false);
}

function evhan_keyup(ev)
{
    if (!ptt_matches_up(ev))
        return;
    ev.preventDefault();
    ev.stopPropagation();
    stop_listening(false);
}

/* The "Listen (Toggle)" menu command: start recording, or stop and
   transcribe if already recording. */
function listen_toggle()
{
    if (listening) {
        stop_listening(false);
    }
    else {
        start_listening(true);
    }
}

/* --- The audiobar --- */

function construct_audiobar()
{
    bar_el = $('#audiobar');
    if (!bar_el || !bar_el.length) {
        bar_el = null;
        return;
    }
    bar_el.empty();

    bar_mic_el = $('<button>', { id:'audiobar_mic', title:'Hold to talk' }).text('🎤');
    bar_icon_el = $('<span>', { id:'audiobar_icon' });
    bar_text_el = $('<span>', { id:'audiobar_text' });
    bar_meter_el = $('<span>', { id:'audiobar_meter' });
    bar_el.append(bar_mic_el);
    bar_el.append(bar_icon_el);
    bar_el.append(bar_text_el);
    bar_el.append(bar_meter_el);

    /* The button must not take keyboard focus away from the game. */
    bar_mic_el.on('mousedown', function(ev) {
        ev.preventDefault();
        if (ev.button != 0)
            return;
        if (listening && listen_toggle_mode) {
            stop_listening(false);
            return;
        }
        start_listening(false);
    });
    bar_mic_el.on('mouseup mouseleave', function(ev) {
        if (listening && !listen_toggle_mode)
            stop_listening(false);
    });
    bar_mic_el.on('click', function(ev) {
        ev.preventDefault();
    });

    window.addEventListener('keydown', evhan_keydown, true);
    window.addEventListener('keyup', evhan_keyup, true);
    window.addEventListener('blur', function() {
        /* If the window loses focus mid-hold, we'll never see the
           key-up. */
        if (listening && !listen_toggle_mode)
            stop_listening(false);
    });

    update_bar();
}

/* Set the bar to a definite state: 'speaking', 'listening',
   'transcribing'. Other states are derived in update_bar(). */
function set_bar_state(state)
{
    if (status_timer) {
        clearTimeout(status_timer);
        status_timer = null;
    }
    update_bar(state);
}

/* Show a message for a while, then go back to the normal display. */
function show_transient(msg, delay, kind)
{
    if (!bar_el)
        return;
    if (status_timer) {
        clearTimeout(status_timer);
        status_timer = null;
    }
    bar_el.attr('class', 'CanHaveInputFocus' + (kind == 'error' ? ' Error' : ' Message'));
    bar_icon_el.text(kind == 'error' ? '⚠' : '💬');
    bar_text_el.text(msg);
    bar_meter_el.css('width', '0px');
    bar_el.css('display', 'block');
    status_timer = setTimeout(function() {
        status_timer = null;
        update_bar();
    }, delay);
}

function update_meter()
{
    if (!bar_meter_el || !listening)
        return;
    /* Map RMS (typically 0..0.3 for speech) onto 0..40 pixels. */
    var val = Math.min(1, listen_level * 6);
    bar_meter_el.css('width', Math.round(val * 40) + 'px');
}

/* Refresh the bar from the current state. */
function update_bar(forcestate)
{
    if (!bar_el)
        return;
    if (status_timer && !forcestate)
        return; /* a transient message is up; leave it */

    var ttson = (prefs && prefs.tts_enabled);
    var stton = (prefs && prefs.stt_enabled);

    if (!ttson && !stton) {
        bar_el.css('display', 'none');
        return;
    }

    var state = forcestate;
    var speaking = (current_jobid !== null || os_utterance !== null || play_sources.length > 0);
    if (!state) {
        if (listening)
            state = 'listening';
        else if (current_reqid !== null)
            state = 'transcribing';
        else if (speaking)
            state = 'speaking';
    }

    var cls = 'CanHaveInputFocus';
    var icon = '';
    var text = '';

    if (state == 'listening') {
        cls += ' Listening';
        icon = '🎤';
        text = 'Listening…';
    }
    else if (state == 'transcribing') {
        cls += ' Transcribing';
        icon = '⌛';
        text = 'Transcribing…';
    }
    else if (state == 'speaking') {
        cls += ' Speaking';
        icon = '🔊';
        text = 'Speaking';
    }
    else {
        /* Idle: report anything the models are up to. */
        var parts = [];
        if (ttson) {
            parts.push(engine_status_text('Voice', status.tts));
        }
        if (stton) {
            parts.push(engine_status_text('Speech input', status.stt));
        }
        parts = parts.filter(function(val) { return val; });
        if (parts.length) {
            cls += ' Info';
            icon = '⚙';
            text = parts.join(' · ');
            for (var key of ['tts', 'stt']) {
                if (status[key].status == 'error')
                    cls = cls.replace(' Info', ' Error');
            }
        }
        else {
            cls += ' Idle';
            icon = '';
            if (stton) {
                var ptt = ptt_spec();
                text = 'Hold ' + (ptt ? ptt.label : 'the talk key') + ' to speak';
            }
            else {
                text = '';
            }
        }
    }

    bar_el.attr('class', cls);
    bar_icon_el.text(icon);
    bar_text_el.text(text);
    if (state != 'listening')
        bar_meter_el.css('width', '0px');
    bar_mic_el.css('display', stton ? 'inline-block' : 'none');
    bar_mic_el.attr('title', listening ? 'Release to send' : 'Hold to talk');

    var visible = (state || text || stton);
    bar_el.css('display', visible ? 'block' : 'none');
}

function engine_status_text(label, state)
{
    switch (state.status) {
    case 'downloading':
        return label + ' model: downloading' + (state.pct !== null && state.pct !== undefined ? ' ' + state.pct + '%' : '…');
    case 'loading':
        return label + ' model: loading…';
    case 'error':
        return label + ' model failed: ' + (state.error || 'unknown error');
    case 'unloaded':
        return label + ' model: starting…';
    default:
        return null;
    }
}

/* --- Hooks called from apphooks.js (via IPC from main.js) --- */

function set_audio_prefs(obj)
{
    prefs = obj;
    if (!prefs.audio_available) {
        prefs.tts_enabled = false;
        prefs.stt_enabled = false;
    }

    if (!prefs.tts_enabled) {
        stop_playback();
    }
    if (!prefs.stt_enabled) {
        release_mic();
    }
    update_bar();
}

function set_audio_status(obj)
{
    if (obj && obj.tts)
        status.tts = obj.tts;
    if (obj && obj.stt)
        status.stt = obj.stt;
    debug('status tts=' + status.tts.status + ' stt=' + status.stt.status);

    if (pending_text !== null) {
        var text = pending_text;
        if (status.tts.status == 'ready') {
            pending_text = null;
            if (prefs && prefs.tts_enabled)
                speak(text);
        }
        else if (status.tts.status == 'downloading' || status.tts.status == 'error') {
            /* Not happening soon after all; use the fallback voice. */
            pending_text = null;
            if (prefs && prefs.tts_enabled)
                speak(text);
        }
    }
    update_bar();
}

/* Handle a page unload (game reset): stop everything. */
window.addEventListener('beforeunload', function() {
    try {
        stop_playback();
        release_mic();
    }
    catch (ex) {}
});

exports.record_update = record_update;
exports.construct_audiobar = construct_audiobar;
exports.set_audio_prefs = set_audio_prefs;
exports.set_audio_status = set_audio_status;
exports.speech_audio = on_speech_audio;
exports.speech_done = on_speech_done;
exports.speech_result = on_speech_result;
exports.speech_stt_error = on_speech_stt_error;
exports.speech_stop_playback = stop_playback;
exports.speech_repeat = repeat_last;
exports.speech_listen_toggle = listen_toggle;
exports.extract_speech_text = extract_speech_text;
