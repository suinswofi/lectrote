'use strict';

/* The Lectrote audio engine. This runs in an Electron utility process
   (see main.js, ensure_audio_engine()). It owns the speech models --
   Kokoro for text-to-speech, Whisper for speech-to-text -- and runs
   inference off the UI thread. There is one engine for the whole app,
   shared by all game windows.

   The main process talks to us over process.parentPort. Messages in:

   - init { modeldir }: where to cache downloaded models. Sent first.
   - tts_load { model, dtype } / tts_unload
   - tts_speak { winid, jobid, text, voice, speed }
   - tts_stop { winid }: winid null means all windows
   - stt_load { model, dtype } / stt_unload
   - stt_transcribe { winid, reqid, audio (Float32Array, 16kHz mono) }
   - shutdown

   Messages out:

   - ready: engine has booted
   - status { engine:'tts'|'stt', status, model, error }: status is one of
     unloaded, downloading, loading, ready, error
   - progress { engine, pct, file }: download progress (throttled)
   - tts_audio { winid, jobid, seq, text, audio (Float32Array), sample_rate }
   - tts_done { winid, jobid, cancelled }
   - stt_result { winid, reqid, text, ms }
   - stt_error { winid, reqid, error }
   - log { msg }

   Audio buffers cross the port by structured clone, which is fine at
   these sizes (a few hundred KB per sentence).
*/

const port = process.parentPort;
const fs = require('fs');
const path_mod = require('path');

/* The heavy modules are required lazily, the first time a load is
   requested, so that a bare engine boots quickly. */
var transformers = null;
var kokoro = null;

var modeldir = null;

var tts = null;           /* KokoroTTS instance */
var tts_state = { status:'unloaded', model:null, error:null };
var tts_loading = null;   /* promise while a load is in flight */
var tts_queue = [];       /* pending tts_speak jobs */
var tts_current = null;   /* job being generated */
var tts_running = false;

var stt = null;           /* transformers ASR pipeline */
var stt_state = { status:'unloaded', model:null, error:null };
var stt_loading = null;
var stt_queue = [];
var stt_running = false;

function send(obj)
{
    port.postMessage(obj);
}

function log(msg)
{
    send({ type:'log', msg:msg });
}

function set_state(engine, status, error)
{
    var state = (engine == 'tts') ? tts_state : stt_state;
    state.status = status;
    state.error = (error ? String(error && error.message ? error.message : error) : null);
    send({ type:'status', engine:engine, status:state.status, model:state.model, error:state.error });
}

function load_modules()
{
    if (!transformers) {
        transformers = require('@huggingface/transformers');
        if (modeldir)
            transformers.env.cacheDir = modeldir;
        if (process.env.HF_ENDPOINT)
            transformers.env.remoteHost = process.env.HF_ENDPOINT;
    }
    if (!kokoro) {
        kokoro = require('kokoro-js');
    }
}

/* Is this model already in the cache directory? (transformers.js
   reports read progress for cached files exactly as it does for
   downloads, so we can't tell the two apart from the events alone. We
   check whether the model's onnx directory has been populated.)
*/
function is_model_cached(model)
{
    if (!modeldir)
        return false;
    try {
        var dir = path_mod.join(modeldir, model, 'onnx');
        var ls = fs.readdirSync(dir);
        return (ls.length > 0);
    }
    catch (ex) {
        return false;
    }
}

/* Build a progress_callback for from_pretrained() which aggregates the
   per-file download events into one percentage, throttled so we don't
   flood the port. If the model is already cached, the progress events
   are just file reads, so we don't report a download at all.
*/
function make_progress_handler(engine, model)
{
    var files = new Map(); /* file -> { loaded, total } */
    var lastsend = 0;
    var announced = false;
    var cached = is_model_cached(model);

    return function(ev) {
        if (ev.status == 'progress') {
            if (cached)
                return;
            files.set(ev.file, { loaded:ev.loaded || 0, total:ev.total || 0 });
            if (!announced) {
                announced = true;
                set_state(engine, 'downloading', null);
            }
            var now = Date.now();
            if (now - lastsend < 250)
                return;
            lastsend = now;
            var loaded = 0, total = 0;
            for (var val of files.values()) {
                loaded += val.loaded;
                total += val.total;
            }
            var pct = (total > 0) ? Math.floor(100 * loaded / total) : 0;
            send({ type:'progress', engine:engine, pct:pct, file:ev.file });
        }
        else if (ev.status == 'done' && announced) {
            var val = files.get(ev.file);
            if (val)
                val.loaded = val.total;
        }
    };
}

/* --- Text-to-speech --- */

async function tts_load(arg)
{
    if (tts_loading)
        return tts_loading;
    if (tts && tts_state.model == arg.model)
        return;

    tts_loading = (async function() {
        try {
            if (tts) {
                await tts_unload();
            }
            tts_state.model = arg.model;
            set_state('tts', 'loading', null);
            load_modules();
            var model = await kokoro.KokoroTTS.from_pretrained(arg.model, {
                dtype: arg.dtype || 'q8',
                device: 'cpu',
                progress_callback: make_progress_handler('tts', arg.model)
            });
            tts = model;
            set_state('tts', 'ready', null);
        }
        catch (ex) {
            tts = null;
            log('tts load failed: ' + (ex.stack || ex));
            set_state('tts', 'error', ex);
        }
        finally {
            tts_loading = null;
        }
        run_tts_queue();
    })();
    return tts_loading;
}

async function tts_unload()
{
    tts_cancel(null);
    var model = tts;
    tts = null;
    tts_state.model = null;
    set_state('tts', 'unloaded', null);
    if (model && model.model && model.model.dispose) {
        try {
            await model.model.dispose();
        }
        catch (ex) {}
    }
}

function tts_speak(arg)
{
    if (!tts && !tts_loading) {
        send({ type:'tts_done', winid:arg.winid, jobid:arg.jobid, cancelled:true });
        return;
    }
    tts_queue.push({ winid:arg.winid, jobid:arg.jobid, text:arg.text, voice:arg.voice, speed:arg.speed, cancelled:false });
    run_tts_queue();
}

/* Cancel all jobs for a window (or all windows). A job in the middle of
   generation finishes its current sentence and then stops. */
function tts_cancel(winid)
{
    var keep = [];
    for (var job of tts_queue) {
        if (winid === null || job.winid === winid) {
            job.cancelled = true;
            send({ type:'tts_done', winid:job.winid, jobid:job.jobid, cancelled:true });
        }
        else {
            keep.push(job);
        }
    }
    tts_queue = keep;
    if (tts_current && (winid === null || tts_current.winid === winid)) {
        tts_current.cancelled = true;
    }
}

async function run_tts_queue()
{
    if (tts_running)
        return;
    tts_running = true;
    try {
        while (tts_queue.length) {
            if (!tts && tts_loading) {
                /* Jobs may arrive while the model is still loading; hold
                   them until it is ready. */
                await tts_loading;
                continue;
            }
            var job = tts_queue.shift();
            if (job.cancelled)
                continue;
            if (!tts) {
                /* Model went away (unload or load failure). */
                send({ type:'tts_done', winid:job.winid, jobid:job.jobid, cancelled:true });
                continue;
            }
            tts_current = job;
            try {
                await run_tts_job(job);
            }
            catch (ex) {
                log('tts job failed: ' + (ex.stack || ex));
                job.cancelled = true;
            }
            tts_current = null;
            send({ type:'tts_done', winid:job.winid, jobid:job.jobid, cancelled:job.cancelled });
        }
    }
    finally {
        tts_running = false;
    }
}

async function run_tts_job(job)
{
    var splitter = new kokoro.TextSplitterStream();
    var stream = tts.stream(splitter, { voice:job.voice || 'af_heart', speed:job.speed || 1.0 });
    splitter.push(job.text);
    splitter.close();

    var seq = 0;
    for await (const chunk of stream) {
        if (job.cancelled)
            break;
        var audio = chunk.audio;
        send({
            type: 'tts_audio',
            winid: job.winid,
            jobid: job.jobid,
            seq: seq,
            text: chunk.text,
            audio: audio.audio,
            sample_rate: audio.sampling_rate
        });
        seq++;
    }
}

/* --- Speech-to-text --- */

async function stt_load(arg)
{
    if (stt_loading)
        return stt_loading;
    if (stt && stt_state.model == arg.model)
        return;

    stt_loading = (async function() {
        try {
            if (stt) {
                await stt_unload();
            }
            stt_state.model = arg.model;
            set_state('stt', 'loading', null);
            load_modules();
            var pipe = await transformers.pipeline('automatic-speech-recognition', arg.model, {
                dtype: arg.dtype || 'q8',
                device: 'cpu',
                progress_callback: make_progress_handler('stt', arg.model)
            });
            /* Warm up: the first inference is much slower than the rest. */
            await pipe(new Float32Array(16000));
            stt = pipe;
            set_state('stt', 'ready', null);
        }
        catch (ex) {
            stt = null;
            log('stt load failed: ' + (ex.stack || ex));
            set_state('stt', 'error', ex);
        }
        finally {
            stt_loading = null;
        }
        run_stt_queue();
    })();
    return stt_loading;
}

async function stt_unload()
{
    var pipe = stt;
    stt = null;
    stt_state.model = null;
    set_state('stt', 'unloaded', null);
    for (var req of stt_queue) {
        send({ type:'stt_error', winid:req.winid, reqid:req.reqid, error:'Speech recognition was turned off.' });
    }
    stt_queue = [];
    if (pipe && pipe.dispose) {
        try {
            await pipe.dispose();
        }
        catch (ex) {}
    }
}

function stt_transcribe(arg)
{
    if (!stt && !stt_loading) {
        send({ type:'stt_error', winid:arg.winid, reqid:arg.reqid, error:'Speech recognition model is not loaded.' });
        return;
    }
    stt_queue.push({ winid:arg.winid, reqid:arg.reqid, audio:arg.audio });
    run_stt_queue();
}

async function run_stt_queue()
{
    if (stt_running)
        return;
    stt_running = true;
    try {
        while (stt_queue.length) {
            if (!stt && stt_loading) {
                await stt_loading;
                continue;
            }
            var req = stt_queue.shift();
            if (!stt) {
                send({ type:'stt_error', winid:req.winid, reqid:req.reqid, error:'Speech recognition model is not loaded.' });
                continue;
            }
            try {
                var start = Date.now();
                var audio = req.audio;
                if (!(audio instanceof Float32Array))
                    audio = new Float32Array(audio);
                var opts = {};
                if (audio.length > 30 * 16000) {
                    opts.chunk_length_s = 30;
                    opts.stride_length_s = 5;
                }
                var res = await stt(audio, opts);
                var text = clean_transcript(res && res.text ? res.text : '');
                send({ type:'stt_result', winid:req.winid, reqid:req.reqid, text:text, ms:(Date.now() - start) });
            }
            catch (ex) {
                log('stt failed: ' + (ex.stack || ex));
                send({ type:'stt_error', winid:req.winid, reqid:req.reqid, error:String(ex.message || ex) });
            }
        }
    }
    finally {
        stt_running = false;
    }
}

/* Whisper emits bracketed non-speech tokens on silence or noise. Strip
   those and tidy the whitespace. */
function clean_transcript(text)
{
    text = text.replace(/\[[^\]]*\]/g, ' ');
    text = text.replace(/\([^)]*\)/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
}

/* --- Message dispatch --- */

async function handle_message(msg)
{
    if (!msg || !msg.type)
        return;
    switch (msg.type) {

    case 'init':
        modeldir = msg.modeldir;
        if (transformers && modeldir)
            transformers.env.cacheDir = modeldir;
        break;

    case 'tts_load':
        tts_load(msg);
        break;
    case 'tts_unload':
        await tts_unload();
        break;
    case 'tts_speak':
        tts_speak(msg);
        break;
    case 'tts_stop':
        tts_cancel(msg.winid === undefined ? null : msg.winid);
        break;

    case 'stt_load':
        stt_load(msg);
        break;
    case 'stt_unload':
        await stt_unload();
        break;
    case 'stt_transcribe':
        stt_transcribe(msg);
        break;

    case 'shutdown':
        try {
            await tts_unload();
            await stt_unload();
        }
        catch (ex) {}
        process.exit(0);
        break;

    default:
        log('unknown message type: ' + msg.type);
        break;
    }
}

port.on('message', function(ev) {
    handle_message(ev.data).catch(function(ex) {
        log('message handler failed: ' + (ex.stack || ex));
    });
});

process.on('uncaughtException', function(ex) {
    log('uncaught exception: ' + (ex.stack || ex));
});
process.on('unhandledRejection', function(ex) {
    log('unhandled rejection: ' + ((ex && ex.stack) || ex));
});

send({ type:'ready' });
