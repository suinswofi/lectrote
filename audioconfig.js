'use strict';

/* This module is used by the main process (main.js), the game process
   (speech.js), the prefs window (prefs.js), and the audio engine process
   (audioengine.js). It contains the shared constants for the speech
   features: which models we use, which voices we offer, and the
   push-to-talk key choices.

   All models are downloaded on demand from Hugging Face into the app's
   user-data directory (see main.js). Nothing is bundled with the app.
*/

/* The Kokoro text-to-speech model. kokoro-js ships the voice style
   vectors inside the npm package, so only the model itself is
   downloaded. */
const tts_model = {
    id: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    dtype: 'q8',
    sizelabel: '~90 MB',
    sample_rate: 24000
};

/* Kokoro voices we offer in the prefs menu. (kokoro-js knows about more,
   but many are low quality; this is the curated set.) */
const tts_voices = [
    { id:'af_heart',    label:'Heart (American, female)' },
    { id:'af_bella',    label:'Bella (American, female)' },
    { id:'af_nicole',   label:'Nicole (American, female)' },
    { id:'af_sarah',    label:'Sarah (American, female)' },
    { id:'am_michael',  label:'Michael (American, male)' },
    { id:'am_fenrir',   label:'Fenrir (American, male)' },
    { id:'am_puck',     label:'Puck (American, male)' },
    { id:'bf_emma',     label:'Emma (British, female)' },
    { id:'bf_isabella', label:'Isabella (British, female)' },
    { id:'bm_george',   label:'George (British, male)' },
    { id:'bm_fable',    label:'Fable (British, male)' }
];

const tts_speed_min = 0.7;
const tts_speed_max = 1.5;
const tts_speed_step = 0.05;

/* Whisper speech-to-text models. The id is the Hugging Face repo name;
   the key is what we store in prefs. */
const stt_models = [
    {
        key: 'whisper-base.en',
        id: 'onnx-community/whisper-base.en',
        dtype: { encoder_model:'fp32', decoder_model_merged:'q8' },
        label: 'Whisper base (fastest, ~130 MB)'
    },
    {
        key: 'whisper-small.en',
        id: 'onnx-community/whisper-small.en',
        dtype: { encoder_model:'fp32', decoder_model_merged:'q8' },
        label: 'Whisper small (recommended, ~490 MB)'
    },
    {
        key: 'whisper-large-v3-turbo',
        id: 'onnx-community/whisper-large-v3-turbo',
        dtype: { encoder_model:'q8', decoder_model_merged:'q8' },
        label: 'Whisper large v3 turbo (best, ~900 MB, slow on CPU)'
    }
];

const stt_sample_rate = 16000;

/* Push-to-talk keys. Each is a "key spec": the renderer matches it
   against KeyboardEvent.code (any of the codes) and the modifier flags.
   A spec with modifier:true is a bare modifier key (hold Ctrl by
   itself), for which the flags are not checked. The 'custom' entry
   means "use the spec stored in the stt_ptt_custom pref", which the
   prefs window builds with ptt_spec_from_event(). */
const ptt_keys = [
    { key:'ctrl-space',       label:'Ctrl+Space',        codes:['Space'], ctrl:true,  shift:false, alt:false },
    { key:'ctrl-shift-space', label:'Ctrl+Shift+Space',  codes:['Space'], ctrl:true,  shift:true,  alt:false },
    { key:'alt-space',        label:'Alt+Space',         codes:['Space'], ctrl:false, shift:false, alt:true },
    { key:'ctrl',             label:'Ctrl (either side)', codes:['ControlLeft', 'ControlRight'], modifier:true },
    { key:'ctrl-right',       label:'Right Ctrl',        codes:['ControlRight'], modifier:true },
    { key:'alt',              label:'Alt (either side)',  codes:['AltLeft', 'AltRight'], modifier:true },
    { key:'alt-right',        label:'Right Alt',         codes:['AltRight'], modifier:true },
    { key:'f8',               label:'F8',                codes:['F8'],    ctrl:false, shift:false, alt:false },
    { key:'f9',               label:'F9',                codes:['F9'],    ctrl:false, shift:false, alt:false },
    { key:'custom',           label:'Custom…',       custom:true }
];

/* Build a key spec from a KeyboardEvent (in the prefs window, when the
   user picks a custom key). Returns null if the event isn't usable. */
function ptt_spec_from_event(ev)
{
    if (!ev || !ev.code)
        return null;
    var modnames = { 'Control':'Ctrl', 'Alt':'Alt', 'Shift':'Shift', 'Meta':'Meta' };
    if (modnames[ev.key]) {
        var side = '';
        if (ev.code.endsWith('Left'))
            side = 'Left ';
        else if (ev.code.endsWith('Right'))
            side = 'Right ';
        return { codes:[ev.code], modifier:true, label:side + modnames[ev.key] };
    }
    if (ev.key == 'Escape' || ev.key == 'Tab' || ev.key == 'Enter')
        return null;
    var name = ev.code;
    if (name.startsWith('Key'))
        name = name.slice(3);
    else if (name.startsWith('Digit'))
        name = name.slice(5);
    else if (name.startsWith('Numpad'))
        name = 'Numpad ' + name.slice(6);
    else if (name.startsWith('Arrow'))
        name = name.slice(5) + ' arrow';
    var label = '';
    if (ev.ctrlKey)
        label += 'Ctrl+';
    if (ev.altKey)
        label += 'Alt+';
    if (ev.shiftKey)
        label += 'Shift+';
    if (ev.metaKey)
        label += 'Meta+';
    label += name;
    return { codes:[ev.code], ctrl:ev.ctrlKey, alt:ev.altKey, shift:ev.shiftKey, meta:ev.metaKey, label:label };
}

/* Given the prefs (stt_ptt_key, stt_ptt_custom), return the key spec
   to use, falling back to the default. */
function ptt_spec_for_prefs(prefs)
{
    var key = prefs ? prefs.stt_ptt_key : null;
    if (key == 'custom') {
        var spec = prefs.stt_ptt_custom;
        if (spec && spec.codes && spec.codes.length)
            return spec;
    }
    var val = ptt_key_for_key(key);
    if (!val || val.custom)
        val = ptt_key_for_key(pref_defaults.stt_ptt_key);
    return val;
}

/* Longest utterance we will record before cutting off, in seconds. */
const ptt_max_seconds = 30;
/* Recordings shorter than this are discarded (Whisper hallucinates on
   near-silence). */
const ptt_min_seconds = 0.3;

/* Longest single turn's text we will send to the TTS engine. */
const speech_max_chars = 8000;

/* Default preference values; main.js merges these into its prefs. */
const pref_defaults = {
    tts_enabled: false,
    tts_voice: 'af_heart',
    tts_speed: 1.0,
    tts_speak_input: false,
    tts_fallback_os: true,
    stt_enabled: false,
    stt_model: 'whisper-small.en',
    stt_auto_submit: true,
    stt_ptt_key: 'ctrl-space',
    stt_ptt_custom: null   /* a key spec, when stt_ptt_key is 'custom' */
};

function stt_model_for_key(key)
{
    for (var model of stt_models) {
        if (model.key == key)
            return model;
    }
    return null;
}

function ptt_key_for_key(key)
{
    for (var ptt of ptt_keys) {
        if (ptt.key == key)
            return ptt;
    }
    return null;
}

exports.tts_model = tts_model;
exports.tts_voices = tts_voices;
exports.tts_speed_min = tts_speed_min;
exports.tts_speed_max = tts_speed_max;
exports.tts_speed_step = tts_speed_step;
exports.stt_models = stt_models;
exports.stt_sample_rate = stt_sample_rate;
exports.ptt_keys = ptt_keys;
exports.ptt_max_seconds = ptt_max_seconds;
exports.ptt_min_seconds = ptt_min_seconds;
exports.speech_max_chars = speech_max_chars;
exports.pref_defaults = pref_defaults;
exports.stt_model_for_key = stt_model_for_key;
exports.ptt_key_for_key = ptt_key_for_key;
exports.ptt_spec_from_event = ptt_spec_from_event;
exports.ptt_spec_for_prefs = ptt_spec_for_prefs;
