'use strict';
const electron = require('electron');
const app = electron.app;
const fs = require('fs');
const path_mod = require('path');

const formats = require('./formats.js');
const traread = require('./traread.js');
const audioconfig = require('./audioconfig.js');

var package_json = {}; /* parsed form of our package.json file */
var main_extension = {}; /* extra code for bound games */

var isbound = false; /* true if we're a single-game app */
var bound_game_path = null;
var winmenus = {}; /* maps window ID to a Menu (Win/Linux only) */
var gamewins = {}; /* maps window ID to a game structure */
var trawins = {}; /* maps window ID to a trashow structure */
var aboutwin = null; /* the splash/about window, if active */
var cardwin = null; /* the postcard window, if active */
var prefswin = null; /* the preferences window, if active */
var transcriptwin = null; /* the transcript browser window, if active */
var gamedialog = false; /* track whether the game-open dialog is visible */

var prefs = {
    gamewin_width: 600,
    gamewin_height: 800,
    gamewin_marginlevel: 1,
    gamewin_colortheme: 'lightdark',
    gamewin_font: 'lora',
    gamewin_customfont: null,
    gamewin_zoomlevel: 0,
    trashowwin_width: 600,
    trashowwin_height: 530,
    traretain_for: 'forever',
    traretain_count: 30,
    traretain_daycount: 30,
    glulx_terp: 'quixe'   // engine.id from formats.js
    // could also have zcode_terp, hugo_terp, ink-json_terp here. (I know, ink-json_terp is ugly, I should rename that.)
};
/* The speech (TTS/STT) preferences: tts_enabled, tts_voice, stt_enabled,
   etc. See audioconfig.js. */
for (var key in audioconfig.pref_defaults) {
    prefs[key] = audioconfig.pref_defaults[key];
}
var prefspath = path_mod.join(app.getPath('userData'), 'lectrote-prefs.json');
var prefstimer = null;
var prefswriting = false;

/* Speech feature state. The audio engine is a utility process (see
   audioengine.js) which owns the speech models. There is at most one,
   shared by all game windows. */
var audio_available = false; /* true if the speech modules are installed for this platform */
var audioengine = null; /* the engine process, if running */
var audioengine_ready = false; /* it has booted and accepted our init message */
var audio_idletimer = null; /* timer to shut down an unused engine */
var audio_status = {
    tts: { status:'unloaded', model:null, pct:null, error:null },
    stt: { status:'unloaded', model:null, pct:null, error:null }
};

var app_ready = false; /* true once the ready event occurs */
var app_quitting = false; /* true once the will-quit event occurs */
var launch_paths = []; /* game files passed in before app_ready */
var aboutwin_initial = false; /* true if the aboutwin was auto-opened */
var selected_transcript = null; /* in the transcript window */
var window_icon = null; /* icon to apply to all windows (only used on Linux) */
var tray_icon = null; /* icon to use for system tray (only on Windows) */

var search_string = ''; /* recent text search in a game window */

/* Return a list of all open game objects. */
function game_list()
{
    var ls = [];
    for (var id in gamewins) {
        var game = gamewins[id];
        ls.push(game);
    }
    return ls;
}

/* Return the game object for a given window. */
function game_for_window(win)
{
    if (!win)
        return undefined;
    return gamewins[win.id];
}

/* Return the game object for a given webcontents. */
function game_for_webcontents(webcontents)
{
    if (!webcontents)
        return undefined;
    for (var id in gamewins) {
        var game = gamewins[id];
        if (game.win && game.win.webContents === webcontents)
            return game;
    }    
    return undefined;
}

/* Return the game object for a given game-file path. */
function game_for_path(path)
{
    for (var id in gamewins) {
        var game = gamewins[id];
        if (game.path == path)
            return game;
    }    
}

/* Return the trashow object for a given window. */
function trashow_for_window(win)
{
    if (!win)
        return undefined;
    return trawins[win.id];
}

/* Get the transcript selected in the given window. This may be a
   trashow window, or the highlighted entry in the transcript browser
   window. Returns the transcript filename. */
function get_active_transcript(win)
{
    if (win == transcriptwin)
        return selected_transcript;
    
    var tra = trashow_for_window(win);
    if (tra)
        return tra.filename;

    return null;
}

/* Return the trashow object for a given webcontents. */
function trashow_for_webcontents(webcontents)
{
    if (!webcontents)
        return undefined;
    for (var id in trawins) {
        var tra = trawins[id];
        if (tra.win && tra.win.webContents === webcontents)
            return tra;
    }    
    return undefined;
}

/* Return the trashow object for a given transcript filename. */
function trashow_for_filename(filename)
{
    if (!filename)
        return undefined;
    for (var id in trawins) {
        var tra = trawins[id];
        if (tra.filename == filename)
            return tra;
    }    
    return undefined;
}

/* A game *or* trashow object. */
function game_trashow_for_window(win)
{
    if (!win)
        return undefined;
    var game = gamewins[win.id];
    if (game)
        return game;
    var tra = trawins[win.id];
    if (tra)
        return tra;
    return undefined;
}

function game_trashow_for_webcontents(webcontents)
{
    if (!webcontents)
        return undefined;
    for (var id in gamewins) {
        var game = gamewins[id];
        if (game.win && game.win.webContents === webcontents)
            return game;
    }    
    for (var id in trawins) {
        var tra = trawins[id];
        if (tra.win && tra.win.webContents === webcontents)
            return tra;
    }    
    return undefined;
}

/* Windows for all games and trashow objects. */
function get_all_game_trashow_windows()
{
    var res = [];
    for (var id in gamewins) {
        var game = gamewins[id];
        if (game.win)
            res.push(game.win);
    }
    for (var id in trawins) {
        var tra = trawins[id];
        if (tra.win)
            res.push(tra.win);
    }
    return res;
}

function construct_recent_game_menu()
{
    var res = [];

    if (isbound)
        return res;

    /* This requires a utility function because of Javascript's lousy 
       closures. */
    var add = function(path) {
        var opts = {
            label: path_mod.basename(path),
            click: function() {
                launch_game(path);
            }
        };
        res.push(opts);
    };
    
    var recents = prefs.recent_games;
    if (recents && recents.length) {
        for (var ix=0; ix<recents.length; ix++) {
            add(recents[ix]);
        }
    }

    return res;
}

/* Add a game to the recently-opened list. Note that this does *not* affect
   the "File / Open Recent" submenu! This is an Electron limitation:
       https://github.com/atom/electron/issues/527
   The submenu will be filled in next time the app launches.
*/
function add_recent_game(path)
{
    if (isbound) {
        /* We're in bound-game mode and shouldn't be talking about
           open lists at all. */
        return;
    }

    /* The system recent list is easy -- it handles its own ordering
       and uniqueness. This list shows up on the Dock icon on MacOS. */
    app.addRecentDocument(path);

    var recents = prefs.recent_games;
    if (recents === undefined) {
        recents = [];
        prefs.recent_games = recents;
    }

    /* Remove any duplicate so we can move this game to the top. */
    for (var ix=0; ix<recents.length; ix++) {
        if (recents[ix] == path) {
            recents.splice(ix, 1);
            break;
        }
    }

    /* Push onto beginning. */
    recents.unshift(path);

    /* Keep no more than 8. */
    if (recents.length > 8)
        recents.length = 8;

    note_prefs_dirty();
}

/* If you create two windows in a row, the second should be offset. But
   if you create a window, close it, and create a new window, the second
   should not be offset. Sorry, it's messy to describe and messy to
   implement.
   The effect is to pick the lowest offset value not used by any window.
   The map argument should be a window collection (gamewins or trawins).
*/
function pick_window_offset(map)
{
    /* Create a list of all offsets currently in use. */
    var offsets = [];
    for (var id in map) {
        var offset = map[id].offset;
        if (offset !== undefined)
            offsets[offset] = true;
    }

    for (var ix=0; true; ix++) {
        if (!offsets[ix])
            return ix;
    }
}

/* If a game window is moved, we no longer care about offsets, because we're
   now offsetting from a new position. Clear our existing offset info.
*/
function clear_window_offsets(map)
{
    for (var id in map) {
        delete map[id].offset;
    }
}

/* Called only at app startup. */
function load_prefs()
{
    try {
        var prefsstr = fs.readFileSync(prefspath, { encoding:'utf8' });
        var obj = JSON.parse(prefsstr);
        for (var key in obj) {
            prefs[key] = obj[key];
        }
    }
    catch (ex) {
        /* console.error('load_prefs: unable to load preferences: %s: %s', prefspath, ex); */
    }
    
    /* Check to make sure the recent files still exist. */
    var recents = prefs.recent_games;
    if (recents && recents.length) {
        var ls = [];
        for (var ix=0; ix<recents.length; ix++) {
            try {
                fs.accessSync(recents[ix], fs.R_OK);
                ls.push(recents[ix]);
            }
            catch (ex) {}
        }
        if (ls.length < recents.length) {
            prefs.recent_games = ls;
            note_prefs_dirty();
        }
    }
}

/* We can't rely on the web-frame algorithm for this, because we have
   to include it when creating the browser window. So we have our
   own bit of code: basically 10% larger/smaller per unit.
*/
function zoom_factor_for_level(val)
{
    if (!val)
        return 1;
    return Math.exp(val * 0.09531017980432493);
}

/* Send the current zoom factor to all game windows.
*/
function set_zoom_factor_all(val)
{
    for (var win of get_all_game_trashow_windows()) {
        invoke_app_hook(win, 'set_zoom_factor', val);
    }
    if (main_extension.set_zoom_factor)
        main_extension.set_zoom_factor(val);
}

/* Set up a window-options object (for creating a BrowserWindow) to have
   a previously-set window position, if there is one.
*/
function window_position_prefs(winopts, key)
{
    var val;

    val = prefs[key+'_x'];
    if (val !== undefined)
        winopts.x = val;

    val = prefs[key+'_y'];
    if (val !== undefined)
        winopts.y = val;
}

/* Set up a window-options object (for creating a BrowserWindow) to have
   a previously-set window size, if there is one. If not, use the
   given defaults.
*/
function window_size_prefs(winopts, key, defwidth, defheight)
{
    var val;

    val = prefs[key+'_width'];
    if (val === undefined)
        val = defwidth;
    winopts.width = val;

    val = prefs[key+'_height'];
    if (val === undefined)
        val = defheight;
    winopts.height = val;
}

/* Create a function that sets the preferences for a window position.
   This can be set as the window's 'move' callback.
*/
function window_position_prefs_handler(key, win)
{
    return function() {
        prefs[key+'_x'] = win.getPosition()[0];
        prefs[key+'_y'] = win.getPosition()[1];
        note_prefs_dirty();
    }
}

/* Create a function that sets the preferences for a window size.
   This can be set as the window's 'resize' callback.
*/
function window_size_prefs_handler(key, win)
{
    return function() {
        prefs[key+'_width'] = win.getSize()[0];
        prefs[key+'_height'] = win.getSize()[1];
        note_prefs_dirty();
    }
}

/* Called whenever we update the prefs object. This waits five seconds 
   (to consolidate writes) and then launches an async file-write.
*/
function note_prefs_dirty()
{
    /* If a timer is in flight, we're covered. */
    if (prefstimer !== null)
        return;
    prefstimer = setTimeout(handle_write_prefs, 5000);
}

/* Callback for prefs-dirty timer. */
function handle_write_prefs()
{
    prefstimer = null;
    /* If prefswriting is true, a writeFile call is in flight. Yes, this
       is an annoying corner case. We have new data to write but we have
       to wait for the writeFile to finish. We do this by punting for
       another five seconds! */
    if (prefswriting) {
        note_prefs_dirty();
        return;
    }

    prefswriting = true;
    var prefsstr = JSON.stringify(prefs);
    fs.writeFile(prefspath, prefsstr, { encoding:'utf8' }, function(err) {
            prefswriting = false;
        });
}

/* Called when the app is shutting down. Write out the prefs if they're dirty.
*/
function write_prefs_now()
{
    if (prefstimer !== null) {
        clearTimeout(prefstimer);
        prefstimer = null;
        var prefsstr = JSON.stringify(prefs);
        fs.writeFileSync(prefspath, prefsstr, { encoding:'utf8' });
    }
}

/* Call one of the functions in apphooks.js (in the game renderer process).
   The argument is passed as a JSON string.
   (This is fire-and-forget! Beware races. If you want to invoke a bunch
   of hooks, use "sequence".)
*/
function invoke_app_hook(win, func, arg)
{
    win.webContents.send(func, arg);
}

/* --- Speech (TTS/STT) support --- */

/* Decide whether the speech features can work at all: the modules must
   be installed (they're omitted from some packaged builds) and the ONNX
   runtime must have a binary for this platform.
*/
function check_audio_available()
{
    if (package_json.lectroteAudioFeatures === false)
        return false;
    try {
        require.resolve('kokoro-js');
        require.resolve('@huggingface/transformers');
    }
    catch (ex) {
        return false;
    }
    var bindir = path_mod.join(__dirname, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', process.platform, process.arch);
    return fs.existsSync(bindir);
}

/* Where downloaded speech models live. */
function audio_model_dir()
{
    return path_mod.join(app.getPath('userData'), 'models');
}

/* Start the audio engine process, if it isn't running.
*/
function ensure_audio_engine()
{
    if (audioengine || !audio_available)
        return;

    var enginepath = path_mod.join(__dirname, 'audioengine.js');
    var child = electron.utilityProcess.fork(enginepath, [], {
        serviceName: 'Lectrote Audio Engine',
        stdio: 'inherit'
    });
    audioengine = child;
    audioengine_ready = false;

    child.on('message', function(msg) {
        if (audioengine !== child)
            return;
        handle_audio_engine_message(msg);
    });
    child.on('exit', function(code) {
        if (audioengine !== child)
            return;
        audioengine = null;
        audioengine_ready = false;
        for (var key of ['tts', 'stt']) {
            audio_status[key] = { status:'unloaded', model:null, pct:null, error:null };
        }
        broadcast_audio_status();
    });
}

/* Shut down the audio engine (politely, then forcibly).
*/
function stop_audio_engine()
{
    if (audio_idletimer) {
        clearTimeout(audio_idletimer);
        audio_idletimer = null;
    }
    var child = audioengine;
    if (!child)
        return;
    audioengine = null;
    audioengine_ready = false;
    try {
        child.postMessage({ type:'shutdown' });
    }
    catch (ex) {}
    setTimeout(function() {
        try {
            child.kill();
        }
        catch (ex) {}
    }, 2000);
    for (var key of ['tts', 'stt']) {
        audio_status[key] = { status:'unloaded', model:null, pct:null, error:null };
    }
    broadcast_audio_status();
}

/* Make the engine's loaded models match the preferences. Called whenever
   a speech pref changes and when the engine boots. If neither feature
   is on, the engine is shut down after a while to free memory.
*/
function sync_audio_engine_loads()
{
    if (!audio_available)
        return;

    if (!prefs.tts_enabled && !prefs.stt_enabled) {
        if (audioengine && !audio_idletimer) {
            audio_idletimer = setTimeout(function() {
                audio_idletimer = null;
                if (!prefs.tts_enabled && !prefs.stt_enabled)
                    stop_audio_engine();
            }, 30000);
        }
        if (audioengine && audioengine_ready) {
            audioengine.postMessage({ type:'tts_unload' });
            audioengine.postMessage({ type:'stt_unload' });
        }
        return;
    }

    if (audio_idletimer) {
        clearTimeout(audio_idletimer);
        audio_idletimer = null;
    }

    ensure_audio_engine();
    if (!audioengine || !audioengine_ready)
        return; /* we'll be called again when it's ready */

    if (prefs.tts_enabled) {
        audioengine.postMessage({ type:'tts_load', model:audioconfig.tts_model.id, dtype:audioconfig.tts_model.dtype });
    }
    else {
        audioengine.postMessage({ type:'tts_unload' });
    }

    if (prefs.stt_enabled) {
        var model = audioconfig.stt_model_for_key(prefs.stt_model);
        if (!model)
            model = audioconfig.stt_model_for_key(audioconfig.pref_defaults.stt_model);
        audioengine.postMessage({ type:'stt_load', model:model.id, dtype:model.dtype });
    }
    else {
        audioengine.postMessage({ type:'stt_unload' });
    }
}

function handle_audio_engine_message(msg)
{
    if (!msg || !msg.type)
        return;
    var game;

    switch (msg.type) {

    case 'ready':
        audioengine_ready = true;
        audioengine.postMessage({ type:'init', modeldir:audio_model_dir() });
        sync_audio_engine_loads();
        break;

    case 'status':
        var state = audio_status[msg.engine];
        if (state) {
            state.status = msg.status;
            state.model = msg.model;
            state.error = msg.error;
            if (msg.status != 'downloading')
                state.pct = null;
            broadcast_audio_status();
        }
        break;

    case 'progress':
        var state = audio_status[msg.engine];
        if (state) {
            state.pct = msg.pct;
            broadcast_audio_status();
        }
        break;

    case 'tts_audio':
        game = gamewins[msg.winid];
        if (game && game.win) {
            invoke_app_hook(game.win, 'speech_audio', { jobid:msg.jobid, seq:msg.seq, text:msg.text, audio:msg.audio, sample_rate:msg.sample_rate });
        }
        break;

    case 'tts_done':
        game = gamewins[msg.winid];
        if (game && game.win) {
            invoke_app_hook(game.win, 'speech_done', { jobid:msg.jobid, cancelled:msg.cancelled });
        }
        break;

    case 'stt_result':
        game = gamewins[msg.winid];
        if (game && game.win) {
            invoke_app_hook(game.win, 'speech_result', { reqid:msg.reqid, text:msg.text, ms:msg.ms });
        }
        break;

    case 'stt_error':
        game = gamewins[msg.winid];
        if (game && game.win) {
            invoke_app_hook(game.win, 'speech_stt_error', { reqid:msg.reqid, error:msg.error });
        }
        break;

    case 'log':
        console.log('audioengine:', msg.msg);
        break;
    }
}

/* The subset of prefs that the game windows need for speech. */
function audio_prefs_for_renderer()
{
    return {
        audio_available: audio_available,
        tts_enabled: (audio_available && prefs.tts_enabled),
        tts_voice: prefs.tts_voice,
        tts_speed: prefs.tts_speed,
        tts_speak_input: prefs.tts_speak_input,
        tts_fallback_os: prefs.tts_fallback_os,
        stt_enabled: (audio_available && prefs.stt_enabled),
        stt_model: prefs.stt_model,
        stt_auto_submit: prefs.stt_auto_submit,
        stt_ptt_key: prefs.stt_ptt_key
    };
}

/* Send the speech prefs to every game window (and the prefs window, so
   its controls stay in sync with menu toggles), and fix up the menu
   checkmarks.
*/
function broadcast_audio_prefs()
{
    var obj = audio_prefs_for_renderer();
    for (var id in gamewins) {
        var game = gamewins[id];
        if (game.win && !game.win.isDestroyed())
            invoke_app_hook(game.win, 'set_audio_prefs', obj);
    }
    if (prefswin && !prefswin.isDestroyed())
        prefswin.webContents.send('set-audio-prefs', obj);
    refresh_audio_menu_items();
}

function broadcast_audio_status()
{
    for (var id in gamewins) {
        var game = gamewins[id];
        if (game.win && !game.win.isDestroyed())
            invoke_app_hook(game.win, 'set_audio_status', audio_status);
    }
    if (prefswin && !prefswin.isDestroyed())
        prefswin.webContents.send('audio-status', audio_status);
}

/* Update the checkmarks on the speech menu items (in every menu, since
   Win/Linux have one per window).
*/
function refresh_audio_menu_items()
{
    var menus = [];
    if (process.platform == 'darwin') {
        menus.push(electron.Menu.getApplicationMenu());
    }
    else {
        for (var id in winmenus)
            menus.push(winmenus[id]);
    }
    for (var menu of menus) {
        if (!menu)
            continue;
        var item = menu.getMenuItemById('tts_enabled');
        if (item)
            item.checked = prefs.tts_enabled;
        var item = menu.getMenuItemById('stt_enabled');
        if (item)
            item.checked = prefs.stt_enabled;
    }
}

/* Turn speech output on or off. This is the single code path for the
   prefs checkbox and the menu item.
*/
function set_tts_enabled(val)
{
    val = (val == true);
    if (!audio_available)
        val = false;
    if (prefs.tts_enabled != val) {
        prefs.tts_enabled = val;
        note_prefs_dirty();
    }
    if (!val && audioengine && audioengine_ready) {
        audioengine.postMessage({ type:'tts_stop', winid:null });
    }
    sync_audio_engine_loads();
    broadcast_audio_prefs();
}

/* Turn speech input on or off. On Mac, this is where we ask for
   microphone permission.
*/
function set_stt_enabled(val)
{
    val = (val == true);
    if (!audio_available)
        val = false;
    if (prefs.stt_enabled != val) {
        prefs.stt_enabled = val;
        note_prefs_dirty();
    }
    if (val && process.platform == 'darwin' && electron.systemPreferences.askForMediaAccess) {
        electron.systemPreferences.askForMediaAccess('microphone').catch(function(ex) {});
    }
    sync_audio_engine_loads();
    broadcast_audio_prefs();
}

/* Given a pathname, figure out what kind of game it is. This relies on
   the format list in formats.js. It returns a format object from that
   file.

   Returns null if the game type is not recognized. Throws an exception
   if the file is unreadable.
*/
function game_file_discriminate(path)
{
    var fd = fs.openSync(path, 'r');
    var buf = Buffer.alloc(64);
    var len = fs.readSync(fd, buf, 0, 64, 0);
    fs.closeSync(fd);

    /* Try Blorbs first. */
    if (buf[0] == 0x46 && buf[1] == 0x4F && buf[2] == 0x52 && buf[3] == 0x4D
        && buf[8] == 0x49 && buf[9] == 0x46 && buf[10] == 0x52 && buf[11] == 0x53) {
        /* Blorb file */
        var gametype = parse_blorb(path);
        if (gametype == 'GLUL')
            return formats.formatmap.glulx;
        else if (gametype == 'ZCOD')
            return formats.formatmap.zcode;
    }

    var pathsuffix = path_mod.extname(path).toLowerCase();
    if (pathsuffix.startsWith('.'))
        pathsuffix = pathsuffix.slice(1);

    /* Try the format identify functions. */
    for (let i = 0; i < formats.formatlist.length; i++) {
        var format = formats.formatlist[i];
        if (format.identify && format.identify(buf, pathsuffix)) {
            return format;
        }
    }

    /* Fall back to checking file extensions. */
    for (let i = 0; i < formats.formatlist.length; i++) {
        var format = formats.formatlist[i];
        if ((!format.extensions) || (!format.engines) || format.mustidentify)
            continue;
        for (var jx=0; jx<format.extensions.length; jx++) {
            if (format.extensions[jx] == pathsuffix) {
                return format;
            }
        }
    }

    return null;
}

/* Given the pathname of a Blorb file, look through it for a Z-code or
   Glulx chunk. Return 'ZCOD' or 'GLUL', or null if neither is found.
*/
function parse_blorb(path)
{
    var res = null;

    var fd = fs.openSync(path, 'r');
    var buf = Buffer.alloc(16);

    var len = fs.readSync(fd, buf, 0, 16, 0);
    if (!(buf[0] == 0x46 && buf[1] == 0x4F && buf[2] == 0x52 && buf[3] == 0x4D
            && buf[8] == 0x49 && buf[9] == 0x46 && buf[10] == 0x52 && buf[11] == 0x53)) {
        /* not Blorb at all. */
        fs.closeSync(fd);
        return null;
    }

    /* Search through the chunks for a Zcode/Glulx chunk. */
    len = fs.readSync(fd, buf, 0, 12, 0);

    var filelen = buf.readUInt32BE(4) + 8;
    var pos = 12;

    while (pos < filelen) {
        len = fs.readSync(fd, buf, 0, 8, pos);
        pos += 8;
        var chunktype = buf.toString('utf8', 0, 4);
        var chunklen = buf.readUInt32BE(4);
        if (chunktype == 'ZCOD' || chunktype == 'GLUL') {
            res = chunktype;
            break;
        }
        pos += chunklen;
        if (pos & 1)
            pos++;
    }

    fs.closeSync(fd);
    return res;
}

/* Bring up the select-a-game dialog. 
*/
function select_load_game()
{
    if (isbound) {
        /* We're in bound-game mode and shouldn't be opening any other
           games. */
        return;
    }

    if (gamedialog) {
        /* The dialog is already up. I'd focus it if I had a way to do that,
           but I don't. */
        return;
    }

    var filters = [];
    for (var ix=0; ix<formats.formatlist.length; ix++) {
        var format = formats.formatlist[ix];
        filters.push({ name:format.longname, extensions:format.extensions });
    }
    
    if (true) {
        /* The file dialog can only show one filter-row at a
           time. So we construct one that has a union of the types, and
           push it onto the beginning of the filters list. */
        var arr = [];
        for (var ix=0; ix<filters.length; ix++)
            arr = arr.concat(filters[ix].extensions);
        filters.unshift({ name: 'All IF Files', extensions: arr });
    }

    var opts = {
        title: 'Select an IF game file',
        properties: ['openFile'],
        filters: filters,
    };

    gamedialog = true;
    electron.dialog.showOpenDialog(null, opts).then(function(res) {
        gamedialog = false;
        if (!res || res.canceled)
            return;
        var ls = res.filePaths;
        if (!ls || !ls.length)
            return;
        launch_game(ls[0]);
    });
}

/* Open a game window for a given game file.
*/
function launch_game(path)
{
    var kind = null;

    /* Figure out what kind of game file this is, so we know which play.html
       file to load. */
    try {
        kind = game_file_discriminate(path);
    }
    catch (ex) {
        electron.dialog.showErrorBox('The game file could not be read.', ''+ex);
        return;
    }

    if (!kind) {
        electron.dialog.showErrorBox('Could not recognize game file.', path);
        return;
    }

    if (aboutwin && aboutwin_initial) {
        /* Dispose of the (temporary) splash window. This needs a time delay
           for some annoying internal reason. */
        setTimeout( function() { if (aboutwin) aboutwin.close(); }, 50);
    }

    add_recent_game(path);

    var engine = kind.engines[0];
    var enginepref = prefs[kind.id+'_terp'];
    if (enginepref) {
        var neweng = formats.enginemap[enginepref];
        if (neweng && neweng.format == kind.id)
            engine = neweng;
    }

    var win = null;
    var game = {
        type: 'game',
        path: path,
        basehtml: engine.html,
        engineid: engine.id,
        title: null,
        signature: null,
        disable_autosave: false, // disable autosave/autorestore entirely
        suppress_autorestore: false, // skip autorestore once
    };

    if (game_for_path(path)) {
        game.disable_autosave = true;
    }

    var winopts = {
        title: require('electron').app.getName(),
        width: prefs.gamewin_width, height: prefs.gamewin_height,
        minWidth: 400, minHeight: 400,
        backgroundColor: (electron.nativeTheme.shouldUseDarkColors ? '#000' : '#FFF'),
        webPreferences: {
            spellcheck: false,
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: false,
            zoomFactor: zoom_factor_for_level(prefs.gamewin_zoomlevel)
        }
    };
    /* Note that Electron recommends contextIsolation:true, but the
       way we're including interpreter code isn't compatible with
       contextIsolation. Shouldn't be a problem since we don't support
       arbitrary remote/game content. */
    /* backgroundColor should maybe be based on darkmode+theme, not
       just the darkmode flag. */
    /* The webPreferences.zoomFactor doesn't seem to take effect in
       Electron 1.6.11, so we'll send it over via IPC later. */

    if (window_icon)
        winopts.icon = window_icon;
    if (process.platform == 'win32' && !isbound) {
        /* On Windows, set the window icon to an appropriate document icon.
           (But not in the bound version -- we leave that as the
           game's app icon.) */
        winopts.icon = path_mod.join(__dirname, kind.docicon);
    }

    /* BUG: The offsetting only applies if you have a window location
       preference. For a brand-new user this will not be true. */
    var offset = pick_window_offset(gamewins);
    if (prefs.gamewin_x !== undefined)
        winopts.x = prefs.gamewin_x + 20 * offset;
    if (prefs.gamewin_y !== undefined)
        winopts.y = prefs.gamewin_y + 20 * offset;

    win = new electron.BrowserWindow(winopts);
    if (!win)
        return;

    game.win = win;
    game.id = win.id;
    game.offset = offset;
    gamewins[game.id] = game;

    if (process.platform != 'darwin') {
        var template = construct_menu_template('game');
        var menu = electron.Menu.buildFromTemplate(template);
        win.setMenu(menu);
        winmenus[win.id] = menu;
    }
    
    if (process.platform == 'darwin' && !isbound) {
        /* On Mac, set the window document link to the game file URL.
           (But not in the bound version.) */
        win.setRepresentedFilename(game.path);
    }

    /* Game window callbacks */

    win.on('closed', function() {
        if (audioengine && audioengine_ready) {
            audioengine.postMessage({ type:'tts_stop', winid:game.id });
        }
        delete gamewins[game.id];
        delete winmenus[game.id];
        game.win = null;
        game = null;
        win = null;
        /* In the bound version, closing the game window means closing
           the app. */
        if (isbound)
            app.quit();
    });
    win.on('focus', function() {
        window_focus_update(win, game);
    });

    win.webContents.on('dom-ready', function() {
        if (!win) {
            return;
        }
        var game = game_for_webcontents(win.webContents);
        if (!game) {
            return;
        }
        var funcs = [];
        funcs.push({
            key: 'set_zoom_factor',
            arg: winopts.webPreferences.zoomFactor });
        funcs.push({
            key: 'set_margin_level',
            arg: prefs.gamewin_marginlevel });
        funcs.push({
            key: 'set_color_theme',
            arg: { theme:prefs.gamewin_colortheme, darklight:electron.nativeTheme.shouldUseDarkColors } });
        funcs.push({
            key: 'set_font',
            arg: { font:prefs.gamewin_font, customfont:prefs.gamewin_customfont } });
        if (game.suppress_autorestore) {
            funcs.push({ key: 'set_clear_autosave', arg: true });
            game.suppress_autorestore = false;
        }
        if (game.disable_autosave) {
            funcs.push({ key: 'set_disable_autosave', arg: true });
        }
        funcs.push({
            key: 'set_audio_prefs',
            arg: audio_prefs_for_renderer() });
        funcs.push({
            key: 'set_audio_status',
            arg: audio_status });
        funcs.push({
            key: 'load_named_game',
            arg: {
                path: game.path, format: kind.id, engine: game.engineid,
                transcriptdir: path_mod.join(app.getPath('userData'), 'transcripts')
            } });

        invoke_app_hook(win, 'sequence', funcs);
    });

    win.webContents.on('did-start-loading', function() {
        /* The page is loading (or reloading, for a game reset). Any
           speech in progress for it is stale. */
        if (audioengine && audioengine_ready && win) {
            audioengine.postMessage({ type:'tts_stop', winid:win.id });
        }
    });

    win.webContents.on('found-in-page', function(ev, res) {
        var game = game_for_window(win);
        if (!game)
            return;
        if (game.foundinpage && game.foundinpage.requestId == res.requestId) {
            /* merge fields into game.foundinpage */
            Object.assign(game.foundinpage, res);
        }
        else {
            game.foundinpage = res;
        }

        if (game.foundinpage.finalUpdate && game.foundinpage.activeMatchOrdinal == game.foundinpage.matches && game.foundinpage.matches > 1) {
            /* The last match, by definition, is in the one in the search
               widget. If we've landed on it, search *again* to jump around
               to the beginning (or back, as the case may be). */
            var webcontents = game.win.webContents;
            var forward = game.searchforward;
            webcontents.findInPage(game.last_search, { findNext:true, forward:forward });
        }
    });

    win.on('resize', window_size_prefs_handler('gamewin', win));
    win.on('move', function() {
        prefs.gamewin_x = win.getPosition()[0];
        prefs.gamewin_y = win.getPosition()[1];
        note_prefs_dirty();

        /* We're starting with a new position, so erase the history of
           what windows go here. */
        clear_window_offsets(gamewins);
        var game = game_for_window(win);
        if (game)
            game.offset = 0;
    });

    /* Load the game UI and go. */
    win.loadURL('file://' + __dirname + '/' + game.basehtml);
}

/* Reset the game by reloading its HTML document.
*/
function reset_game(game)
{
    if (!game.win)
        return;

    var winopts = {
        type: 'question',
        message: 'Are you sure you want to reset the game to the beginning? This will discard all your progress since your last SAVE command.',
        buttons: ['Reset', 'Cancel'],
        cancelId: 1
    };
    if (window_icon)
        winopts.icon = window_icon;

    /* We use a synchronous showMessageBox call, which blocks (is modal for)
       the entire app. The async call would only block the game window, but
       that causes weird results (e.g., cmd-Q fails to shut down the blocked
       game window). */
    var res = electron.dialog.showMessageBoxSync(game.win, winopts);
    if (res == 0) {
        var win = game.win;
        if (!game.disable_autosave) {
            /* Set a flag to inhibit autorestore (but not autosave). This
               will be cleared when the page finishes loading. */
            game.suppress_autorestore = true;
        }
        /* Load the game UI and go. */
        win.loadURL('file://' + __dirname + '/' + game.basehtml);
    }
}

/* Open a transcript browser window. (We must not already have one for this
   filename.)
*/
function open_transcript_display_window(filename)
{
    check_transcript_andthen(
        filename,
        open_transcript_display_window_next,
        (ex) => {
            electron.dialog.showErrorBox('The transcript could not be read.', ''+ex);
        });
}

/* Callback, invoked when we have all the transcript metadata.
*/
function open_transcript_display_window_next(dat)
{
    var filename = dat.filename;
    var path = dat.path;
    
    var win = null;
    var tra = {
        type: 'trashow',
        filename: filename,
        path: path,
        title: dat.title,
        timestamps: false,
    }
    
    var winopts = { 
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: false,
            zoomFactor: zoom_factor_for_level(prefs.gamewin_zoomlevel)
        },
        width: prefs.trashowwin_width, height: prefs.trashowwin_height,
        minWidth: 400, minHeight: 400,
        backgroundColor: (electron.nativeTheme.shouldUseDarkColors ? '#000' : '#FFF'),
    };
    if (window_icon)
        winopts.icon = window_icon;

    var offset = pick_window_offset(trawins);
    if (prefs.trashowwin_x !== undefined)
        winopts.x = prefs.trashowwin_x + 20 * offset;
    if (prefs.trashowwin_y !== undefined)
        winopts.y = prefs.trashowwin_y + 20 * offset;
    
    win = new electron.BrowserWindow(winopts);
    if (!win)
        return;

    tra.win = win;
    tra.id = win.id;
    tra.offset = offset;
    trawins[tra.id] = tra;

    if (process.platform != 'darwin') {
        var template = construct_menu_template('trashow');
        var menu = electron.Menu.buildFromTemplate(template);
        win.setMenu(menu);
        winmenus[win.id] = menu;
    }
    
    win.on('closed', function() {
        delete trawins[tra.id];
        delete winmenus[tra.id];
        tra.win = null;
        tra = null;
        win = null;
    });
    win.on('focus', function() {
        window_focus_update(win, tra);
    });

    win.webContents.on('found-in-page', function(ev, res) {
        var tra = trashow_for_window(win);
        if (!tra)
            return;
        if (tra.foundinpage && tra.foundinpage.requestId == res.requestId) {
            /* merge fields into tra.foundinpage */
            Object.assign(tra.foundinpage, res);
        }
        else {
            tra.foundinpage = res;
        }

        if (tra.foundinpage.finalUpdate && tra.foundinpage.activeMatchOrdinal == tra.foundinpage.matches && tra.foundinpage.matches > 1) {
            /* The last match, by definition, is in the one in the search
               widget. If we've landed on it, search *again* to jump around
               to the beginning (or back, as the case may be). */
            var webcontents = tra.win.webContents;
            var forward = tra.searchforward;
            webcontents.findInPage(tra.last_search, { findNext:true, forward:forward });
        }
    });

    win.on('resize', window_size_prefs_handler('trashowwin', win));
    win.on('move', function() {
        prefs.trashowwin_x = win.getPosition()[0];
        prefs.trashowwin_y = win.getPosition()[1];
        note_prefs_dirty();

        /* We're starting with a new position, so erase the history of
           what windows go here. */
        clear_window_offsets(trawins);
        var tra = trashow_for_window(win);
        if (tra)
            tra.offset = 0;
    });

    win.webContents.on('dom-ready', function() {
        if (!win) {
            return;
        }
        var tra = trashow_for_webcontents(win.webContents);
        if (!tra) {
            return;
        }
        var funcs = [];
        funcs.push({
            key: 'set_zoom_factor',
            arg: winopts.webPreferences.zoomFactor });
        funcs.push({
            key: 'set_margin_level',
            arg: prefs.gamewin_marginlevel });
        funcs.push({
            key: 'set_color_theme',
            arg: { theme:prefs.gamewin_colortheme, darklight:electron.nativeTheme.shouldUseDarkColors } });
        funcs.push({
            key: 'set_font',
            arg: { font:prefs.gamewin_font, customfont:prefs.gamewin_customfont } });
        funcs.push({
            key: 'load_transcript',
            arg: {
                path: tra.path, filename: tra.filename,
                title: tra.title
            } });

        invoke_app_hook(win, 'sequence', funcs);
    });

    win.loadURL('file://' + __dirname + '/trashow.html');
}

/* Open the "About Lectrote" window. (It must not already exist.)
*/
function open_about_window()
{
    var winopts = {
        webPreferences: { nodeIntegration: true, contextIsolation: false, enableRemoteModule: false },
        width: 650, height: 450,
        backgroundColor: (electron.nativeTheme.shouldUseDarkColors ? '#000' : '#FFF'),
        useContentSize: true,
        resizable: false
    };
    if (main_extension.about_window_size) {
        if (main_extension.about_window_size.width)
            winopts.width = main_extension.about_window_size.width;
        if (main_extension.about_window_size.height)
            winopts.height = main_extension.about_window_size.height;
    }
    window_position_prefs(winopts, 'aboutwin');
    if (window_icon)
        winopts.icon = window_icon;

    aboutwin = new electron.BrowserWindow(winopts);

    if (process.platform != 'darwin') {
        var template = construct_menu_template('about');
        var menu = electron.Menu.buildFromTemplate(template);
        aboutwin.setMenu(menu);
        winmenus[aboutwin.id] = menu;
    }
    
    aboutwin.on('closed', function() {
        delete winmenus[aboutwin.id];
        aboutwin = null;
    });
    aboutwin.on('focus', function() {
            window_focus_update(aboutwin, null);
        });
    aboutwin.on('move', window_position_prefs_handler('aboutwin', aboutwin));
    aboutwin.webContents.on('will-navigate', function(ev, url) {
            require('electron').shell.openExternal(url);
            ev.preventDefault();
        });

    aboutwin.webContents.on('dom-ready', function() {
            aboutwin.webContents.send('set-darklight-mode', electron.nativeTheme.shouldUseDarkColors);
            var ls = construct_recent_game_menu();
            aboutwin.webContents.send('recent-count', ls.length);
        });

    aboutwin.loadURL('file://' + __dirname + '/about.html');
}

/* Open the Preferences window. (It must not already exist.)
*/
function open_prefs_window()
{
    var winopts = { 
        webPreferences: { nodeIntegration: true, contextIsolation: false, enableRemoteModule: false },
        width: 600, height: 530,
        backgroundColor: (electron.nativeTheme.shouldUseDarkColors ? '#000' : '#FFF'),
        useContentSize: true,
        resizable: false
    };
    window_position_prefs(winopts, 'prefswin');
    if (window_icon)
        winopts.icon = window_icon;

    prefswin = new electron.BrowserWindow(winopts);

    if (process.platform != 'darwin') {
        var template = construct_menu_template('prefs');
        var menu = electron.Menu.buildFromTemplate(template);
        prefswin.setMenu(menu);
        winmenus[prefswin.id] = menu;
    }
    
    prefswin.on('closed', function() {
        delete winmenus[prefswin.id];
        prefswin = null;
    });
    prefswin.on('focus', function() {
            window_focus_update(prefswin, null);
        });
    prefswin.on('move', window_position_prefs_handler('prefswin', prefswin));

    prefswin.webContents.on('dom-ready', function() {
            prefswin.webContents.send('set-darklight-mode', electron.nativeTheme.shouldUseDarkColors);
            prefswin.webContents.send('current-prefs', { prefs:prefs, isbound:isbound, audioavailable:audio_available, audiostatus:audio_status, modeldir:audio_model_dir() });
        });

    prefswin.loadURL('file://' + __dirname + '/prefs.html');
}

/* Open the IF reference card window. (It must not already exist.)
*/
function open_card_window()
{
    var winopts = {
        webPreferences: { nodeIntegration: true, contextIsolation: false, enableRemoteModule: false },
        width: 810, height: 600,
        backgroundColor: (electron.nativeTheme.shouldUseDarkColors ? '#000' : '#FFF'),
        useContentSize: true
    };
    window_position_prefs(winopts, 'cardwin');
    if (window_icon)
        winopts.icon = window_icon;

    cardwin = new electron.BrowserWindow(winopts);

    if (process.platform != 'darwin') {
        var template = construct_menu_template('card');
        var menu = electron.Menu.buildFromTemplate(template);
        cardwin.setMenu(menu);
        winmenus[cardwin.id] = menu;
    }
    
    cardwin.on('closed', function() {
        delete winmenus[cardwin.id];
        cardwin = null;
    });
    cardwin.on('focus', function() {
            window_focus_update(cardwin, null);
        });
    cardwin.on('move', window_position_prefs_handler('cardwin', cardwin));
    cardwin.webContents.on('will-navigate', function(ev, url) {
            require('electron').shell.openExternal(url);
            ev.preventDefault();
        });

    cardwin.webContents.on('dom-ready', function() {
            cardwin.webContents.send('set-darklight-mode', electron.nativeTheme.shouldUseDarkColors);
        });

    cardwin.loadURL('file://' + __dirname + '/if-card.html');
}

/* Open the Transcript Browser window. (It must not already exist.)
*/
function open_transcript_window()
{
    var winopts = { 
        webPreferences: { nodeIntegration: true, contextIsolation: false, enableRemoteModule: false },
        minWidth: 500, minHeight: 300,
        backgroundColor: (electron.nativeTheme.shouldUseDarkColors ? '#000' : '#FFF'),
        useContentSize: true
    };
    window_position_prefs(winopts, 'transcriptwin');
    window_size_prefs(winopts, 'transcriptwin', 600, 530);
    if (window_icon)
        winopts.icon = window_icon;

    selected_transcript = null;
    
    transcriptwin = new electron.BrowserWindow(winopts);

    if (process.platform != 'darwin') {
        var template = construct_menu_template('transcript');
        var menu = electron.Menu.buildFromTemplate(template);
        transcriptwin.setMenu(menu);
        winmenus[transcriptwin.id] = menu;
    }
    
    transcriptwin.on('closed', function() {
        delete winmenus[transcriptwin.id];
        transcriptwin = null;
        selected_transcript = null;
    });
    transcriptwin.on('focus', function() {
        window_focus_update(transcriptwin, null);
        transcriptwin.webContents.send('on-focus', true);
        });
    transcriptwin.on('blur', function() {
        transcriptwin.webContents.send('on-focus', false);
        });
    transcriptwin.on('resize', window_size_prefs_handler('transcriptwin', transcriptwin));
    transcriptwin.on('move', window_position_prefs_handler('transcriptwin', transcriptwin));

    transcriptwin.webContents.on('dom-ready', function() {
            transcriptwin.webContents.send('set-darklight-mode', electron.nativeTheme.shouldUseDarkColors);
            transcriptwin.webContents.send('set-dir-path', path_mod.join(app.getPath('userData'), 'transcripts'));
        });

    transcriptwin.loadURL('file://' + __dirname + '/transcript.html');
}

function try_save_transcript_text(filename, fromwin)
{
    check_transcript_andthen(
        filename,
        (dat) => {
            var opts = {
                title: 'Save transcript as text',
                message: 'Transcript for "' + dat.title + '"',
                filters: [ { name: 'Text', extensions: ['txt'] } ],
                properties: ['dontAddToRecent'],
            };

            electron.dialog.showSaveDialog(fromwin, opts).then(function(res) {
                if (!res || res.canceled)
                    return;
                var writeopts = {};
                var tra = trashow_for_filename(filename);
                if (tra && tra.timestamps)
                    writeopts.timestamps = true;
                traread.stanzas_write_to_file(res.filePath, dat.path, writeopts)
                    .then(() => {})
                    .catch((ex) => {
                        electron.dialog.showErrorBox('Unable to write.', ''+ex);
                    });
            });
        },
        (ex) => {
            electron.dialog.showErrorBox('This does not appear to be a transcript.', ''+ex);
        });
}

function try_delete_transcript(filename, fromwin)
{
    check_transcript_andthen(
        filename,
        (dat) => {
            var winopts = {
                type: 'question',
                message: 'Really delete this transcript?',
                detail: 'Transcript for "' + dat.title + '"',
                buttons: ['Yes', 'No'],
                cancelId: 1
            };
            if (window_icon)
                winopts.icon = window_icon;
            
            var res = electron.dialog.showMessageBoxSync(fromwin, winopts);
            if (res == 0) {
                try {
                    var tra = trashow_for_filename(filename);
                    if (tra && tra.win) {
                        // Close the associated transcript window
                        setTimeout( function() { tra.win.close(); }, 50);
                    }

                    fs.unlinkSync(dat.path);
                    
                    if (transcriptwin)
                        transcriptwin.send('reload_transcripts');
                }
                catch (ex) { 
                    electron.dialog.showErrorBox('Unable to delete.', ''+ex);
                }
            }
        },
        (ex) => {
            electron.dialog.showErrorBox('This does not appear to be a transcript.', ''+ex);
        });
}

function check_transcript_andthen(filename, onthen, oncatch)
{
    var path = path_mod.join(app.getPath('userData'), 'transcripts', filename);
    
    var iter = traread.stanza_reader(path);
    iter.next()
        .then((res) => {
            iter.return();
            iter = null;
            var dat = { filename:filename, path:path, title:'???' };
            if (res && res.value && res.value.metadata && res.value.metadata.title)
                dat.title = res.value.metadata.title;
            onthen(dat);
        })
        .catch(oncatch);
}

function check_autodelete_transcripts()
{
    if (prefs.traretain_for == 'time' || prefs.traretain_for == 'count') {
        /* This is similar to the get_transcript_info() work in
           transcript.js, but we don't need to read the transcript
           files. */
        try {
            var transcriptdir = path_mod.join(app.getPath('userData'), 'transcripts');
            var ls = [];
            for (var filename of fs.readdirSync(transcriptdir)) {
                if (filename.endsWith('.glktra')) {
                    var path = path_mod.join(transcriptdir, filename);
                    var stat = fs.statSync(path);
                    var modtime = stat.mtime.getTime();
                    ls.push({ path:path, modtime:modtime });
                }
            }
            ls.sort((f1, f2) => (f2.modtime - f1.modtime));

            var dells;
            if (prefs.traretain_for == 'time') {
                var now = new Date();
                var cutoff = now.getTime() - prefs.traretain_daycount * 24 * 60 * 60 * 1000;
                dells = ls.filter(ff => (ff.modtime < cutoff));
            }
            else {
                dells = ls.slice(prefs.traretain_count);
            }
            for (var obj of dells) {
                fs.unlinkSync(obj.path);
            }
        }
        catch (ex) { }
    }
}

function window_focus_update(win, arg)
{
    /* The arg will be a game object, a trashow object, or null for a singleton window. */
    
    var isgame = ((arg && arg.type == 'game') == true);
    var istrashow = ((arg && arg.type == 'trashow') == true);
    
    /* Determine whether the "Display Cover Art" option should be
       enabled or not. */
    var view_cover_art = false;
    if (win && isgame) {
        if (arg.coverimageres !== undefined || main_extension.cover_image_info) {
            view_cover_art = true;
        }
    }

    var menu = null;
    if (process.platform == 'darwin') {
        menu = electron.Menu.getApplicationMenu();
    }
    else {
        menu = winmenus[win.id];
    }

    if (menu) {
        var item = menu.getMenuItemById('view_cover_art');
        if (item)
            item.enabled = view_cover_art;

        var item = menu.getMenuItemById('reset_game');
        if (item)
            item.enabled = isgame;
        
        var item = menu.getMenuItemById('find');
        if (item)
            item.enabled = (isgame || istrashow);
        var item = menu.getMenuItemById('find_next');
        if (item)
            item.enabled = (isgame || istrashow);
        var item = menu.getMenuItemById('find_prev');
        if (item)
            item.enabled = (isgame || istrashow);
        
        var item = menu.getMenuItemById('show_file_location');
        if (item) {
            item.visible = (isgame || istrashow || (win == transcriptwin));
            item.enabled = (isgame || istrashow || (win == transcriptwin && selected_transcript));
        }
        
        var item = menu.getMenuItemById('open_transcript_display');
        if (item) {
            item.visible = (istrashow || (win == transcriptwin));
            item.enabled = (win == transcriptwin && selected_transcript);
        }
        
        var item = menu.getMenuItemById('save_transcript_text');
        if (item) {
            item.visible = (istrashow || (win == transcriptwin));
            item.enabled = (istrashow || (win == transcriptwin && selected_transcript));
        }
        
        var item = menu.getMenuItemById('delete_transcript');
        if (item) {
            item.visible = (istrashow || (win == transcriptwin));
            item.enabled = (istrashow || (win == transcriptwin && selected_transcript));
        }
        
        var item = menu.getMenuItemById('show_transcript_timestamps');
        if (item) {
            item.visible = istrashow;
            item.enabled = istrashow;
            if (istrashow) {
                item.checked = (arg && arg.type == 'trashow' && arg.timestamps);
            }
        }

        var item = menu.getMenuItemById('tts_enabled');
        if (item) {
            item.visible = audio_available;
            item.checked = prefs.tts_enabled;
        }
        var item = menu.getMenuItemById('stt_enabled');
        if (item) {
            item.visible = audio_available;
            item.checked = prefs.stt_enabled;
        }
        for (var key of ['tts_stop', 'tts_repeat', 'stt_listen_toggle', 'audio_separator']) {
            var item = menu.getMenuItemById(key);
            if (item) {
                item.visible = audio_available;
                item.enabled = (isgame && audio_available);
            }
        }
    }
}

function find_in_template(template, key)
{
    for (var ix=0; ix<template.length; ix++) {
        var stanza = template[ix];
        if (stanza.id == key)
            return stanza;
    }
    return null;
};

/* A simplistic copy-file utility. This is asynchronous. */
function copy_file(srcpath, destpath, callback)
{
    var rd = fs.createReadStream(srcpath);
    rd.on('error', callback);
    var wr = fs.createWriteStream(destpath);
    wr.on('error', callback);
    wr.on('close', function(ex) {
            callback(null);
        });
    rd.pipe(wr);
}

function export_game_file(path)
{
    var suffix = path_mod.extname(path);
    if (suffix.startsWith('.'))
        suffix = suffix.slice(1);
    if (!suffix)
        suffix = 'gblorb';
    /*### defaulting to gblorb isn't right for ink files, but really
      the path will always have a suffix. */

    var filename = path_mod.basename(path);

    var opts = {
        title: 'Export a portable game file',
        defaultPath: filename,
        filters: [ { name: 'Game File', extensions: [suffix] } ]
    };

    electron.dialog.showSaveDialog(opts).then(function(res) {
        if (!res || res.canceled)
            return;
        var destpath = res.filePath;
        if (!destpath)
            return;
        copy_file(path, destpath, function(ex) {
            if (ex)
                electron.dialog.showErrorBox('Export failed', ''+ex);
        });
    });
}

function get_export_game_path()
{
    var path = bound_game_path;
    if (main_extension.export_game_path)
        path = main_extension.export_game_path();
    if (!path)
        return null;
    return path;
}

/* The obj could be a game or trashow object; they search the same. */
function search_text(obj, text)
{
    if (!text)
        return;

    search_string = text;
    obj.last_search = text;

    var webcontents = obj.win.webContents;
    webcontents.findInPage(text, {});
}

function search_again(obj, forward)
{
    var text = obj.last_search;
    if (!text)
        return;

    /* If the search widget isn't open, open it. */
    invoke_app_hook(obj.win, 'search_request', { inittext:text });

    var webcontents = obj.win.webContents;
    obj.searchforward = forward;
    webcontents.findInPage(text, { findNext:true, forward:forward });
}

function search_cancel(obj)
{
    var webcontents = obj.win.webContents;
    webcontents.stopFindInPage('keepSelection');
}

function index_in_template(template, key)
{
    for (var ix=0; ix<template.length; ix++) {
        var stanza = template[ix];
        if (stanza.id == key)
            return ix;
    }
    return -1;
};

function construct_menu_template(wintype)
{
    var name = require('electron').app.getName();

    var isgame = (wintype == 'game');
    var istrashow = (wintype == 'trashow');

    /* This is called both for the Mac case (universal menu bar,
       wintype is null) and the Win/Linux case (one menu bar per window,
       wintype set). So the initial state of menu items should be
       correct for Win/Linux. Mac will apply changes in
       window_focus_update(). */

    var template = [
    {
        label: 'File',
        id: 'menu_file',
        submenu: [
        {
            label: 'Open Game...',
            id: 'open_game',
            accelerator: 'CmdOrCtrl+O',
            click: function() {
                select_load_game();
            }
        },
        {
            label: 'Open Recent',
            id: 'open_recent',
            type: 'submenu',
            submenu: construct_recent_game_menu()
        },
        { type: 'separator' },
        {
            label: 'Open Transcript',
            id: 'open_transcript_display',
            enabled: false,
            click: function(item, win) {
                var filename = get_active_transcript(win);
                if (filename) {
                    var tra = trashow_for_filename(filename);
                    if (tra)
                        tra.win.show();
                    else
                        open_transcript_display_window(filename);
                }
            }
        },
        {
            label: 'Save as Text...',
            id: 'save_transcript_text',
            enabled: false,
            click: function(item, win) {
                var filename = get_active_transcript(win);
                if (filename)
                    try_save_transcript_text(filename, win);
            }
        },
        {
            label: 'Delete Transcript',
            id: 'delete_transcript',
            enabled: false,
            click: function(item, win) {
                var filename = get_active_transcript(win);
                if (filename)
                    try_delete_transcript(filename, win);
            }
        },
        {
            label: 'Reset Game...',
            id: 'reset_game',
            accelerator: 'CmdOrCtrl+R',
            enabled: isgame,
            click: function(item, win) {
                var game = game_for_window(win);
                if (!game)
                    return;
                reset_game(game);
            }
        },
        {
            label: 'Export Portable Game File...',
            id: 'export_game',
            visible: (isbound && get_export_game_path() != null),
            click: function(item, win) {
                export_game_file(get_export_game_path());
            }
        },
        {
            label: 'Show File Location',
            id: 'show_file_location',
            enabled: false,
            click: function(item, win) {
                var path = null;
                if (win == transcriptwin) {
                    if (selected_transcript)
                        path = path_mod.join(app.getPath('userData'), 'transcripts', selected_transcript);
                }
                else {
                    var game = game_for_window(win);
                    if (game) {
                        if (game)
                            path = game.path;
                    }
                    else {
                        var tra = trashow_for_window(win);
                        if (tra)
                            path = tra.path;
                    }
                }
                if (path) {
                    electron.shell.showItemInFolder(path);
                }
            }
        },
        {
            label: 'Close Window',
            id: 'close_window',
            accelerator: 'CmdOrCtrl+W',
            role: 'close'
        },
        { type: 'separator' },
        {
            label: 'Transcript Browser',
            accelerator: 'CmdOrCtrl+Shift+T',
            click: function(item, win) {
                if (!transcriptwin)
                    open_transcript_window();
                else
                    transcriptwin.show();
            }
        }
        ]
    },
    {
        label: 'Edit',
        id: 'menu_edit',
        submenu: [
        {
            label: 'Cut',
            accelerator: 'CmdOrCtrl+X',
            enabled: isgame,
            role: 'cut'
        },
        {
            label: 'Copy',
            accelerator: 'CmdOrCtrl+C',
            role: 'copy'
        },
        {
            label: 'Paste',
            accelerator: 'CmdOrCtrl+V',
            enabled: isgame,
            role: 'paste'
        },
        {
            label: 'Select All',
            accelerator: 'CmdOrCtrl+A',
            role: 'selectall'
        },
        { type: 'separator' },
        {
            label: 'Find...',
            id: 'find',
            accelerator: 'CmdOrCtrl+F',
            enabled: (isgame || istrashow),
            click: function(item, win) {
                var obj = game_trashow_for_window(win);
                if (!obj)
                    return;
                invoke_app_hook(win, 'search_request', { inittext:search_string, focus:true });
            }
        },
        {
            label: 'Find Next',
            id: 'find_next',
            accelerator: 'CmdOrCtrl+G',
            enabled: (isgame || istrashow),
            click: function(item, win) {
                var obj = game_trashow_for_window(win);
                if (!obj)
                    return;
                search_again(obj, true);
            }
        },
        {
            label: 'Find Previous',
            id: 'find_prev',
            accelerator: 'CmdOrCtrl+Shift+G',
            enabled: (isgame || istrashow),
            click: function(item, win) {
                var obj = game_trashow_for_window(win);
                if (!obj)
                    return;
                search_again(obj, false);
            }
        },
        { type: 'separator' },
        {
            label: 'Preferences',
            id: 'preferences',
            accelerator: 'CmdOrCtrl+,',
            enabled: (wintype != 'prefs'),
            click: function() {
                if (!prefswin)
                    open_prefs_window();
                else
                    prefswin.show();
            }
        }
        ]
    },
    {
        label: 'View',
        id: 'menu_view',
        submenu: [
        {
            label: 'Zoom In',
            accelerator: 'CmdOrCtrl+=',
            click: function(item, win) {
                prefs.gamewin_zoomlevel += 1;
                if (prefs.gamewin_zoomlevel > 6)
                    prefs.gamewin_zoomlevel = 6;
                note_prefs_dirty();
                var val = zoom_factor_for_level(prefs.gamewin_zoomlevel);
                set_zoom_factor_all(val);
                if (prefswin)
                    prefswin.webContents.send('set-zoom-level', prefs.gamewin_zoomlevel);
            }
        },
        {
            label: 'Zoom Normal',
            accelerator: 'CmdOrCtrl+0',
            click: function(item, win) {
                prefs.gamewin_zoomlevel = 0;
                note_prefs_dirty();
                var val = zoom_factor_for_level(prefs.gamewin_zoomlevel);
                set_zoom_factor_all(val);
                if (prefswin)
                    prefswin.webContents.send('set-zoom-level', prefs.gamewin_zoomlevel);
            }
        },
        {
            label: 'Zoom Out',
            accelerator: 'CmdOrCtrl+-',
            click: function(item, win) {
                prefs.gamewin_zoomlevel -= 1;
                if (prefs.gamewin_zoomlevel < -6)
                    prefs.gamewin_zoomlevel = -6;
                note_prefs_dirty();
                var val = zoom_factor_for_level(prefs.gamewin_zoomlevel);
                set_zoom_factor_all(val);
                if (prefswin)
                    prefswin.webContents.send('set-zoom-level', prefs.gamewin_zoomlevel);
            }
        },
        { type: 'separator', id: 'audio_separator', visible: audio_available },
        {
            label: 'Speak Story Text',
            id: 'tts_enabled',
            type: 'checkbox',
            accelerator: 'CmdOrCtrl+Shift+V',
            visible: audio_available,
            checked: prefs.tts_enabled,
            click: function(item, win) {
                set_tts_enabled(item.checked);
            }
        },
        {
            label: 'Stop Speaking',
            id: 'tts_stop',
            accelerator: 'CmdOrCtrl+.',
            visible: audio_available,
            enabled: false,
            click: function(item, win) {
                var game = game_for_window(win);
                if (!game)
                    return;
                if (audioengine && audioengine_ready)
                    audioengine.postMessage({ type:'tts_stop', winid:game.id });
                invoke_app_hook(game.win, 'speech_stop_playback', null);
            }
        },
        {
            label: 'Repeat Last Turn',
            id: 'tts_repeat',
            accelerator: 'CmdOrCtrl+Shift+R',
            visible: audio_available,
            enabled: false,
            click: function(item, win) {
                var game = game_for_window(win);
                if (!game)
                    return;
                invoke_app_hook(game.win, 'speech_repeat', null);
            }
        },
        {
            label: 'Voice Input (Push to Talk)',
            id: 'stt_enabled',
            type: 'checkbox',
            accelerator: 'CmdOrCtrl+Shift+M',
            visible: audio_available,
            checked: prefs.stt_enabled,
            click: function(item, win) {
                set_stt_enabled(item.checked);
            }
        },
        {
            label: 'Listen (Toggle)',
            id: 'stt_listen_toggle',
            accelerator: 'CmdOrCtrl+Shift+L',
            visible: audio_available,
            enabled: false,
            click: function(item, win) {
                var game = game_for_window(win);
                if (!game)
                    return;
                invoke_app_hook(game.win, 'speech_listen_toggle', null);
            }
        },
        {
            label: 'Show Transcript Timestamps',
            id: 'show_transcript_timestamps',
            type: 'checkbox',
            click: function(item, win) {
                var tra = trashow_for_window(win);
                if (tra) {
                    tra.timestamps = item.checked;
                    win.webContents.send('set_show_timestamps', tra.timestamps);
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Display Cover Art',
            id: 'view_cover_art',
            enabled: false,
            click: function(item, win) {
                var game = game_for_window(win);
                if (!game)
                    return;
                var dat = null;
                if (main_extension.cover_image_info)
                    dat = main_extension.cover_image_info;
                invoke_app_hook(game.win, 'display_cover_art', dat);
            }
        }
        ]
    },
    {
        label: 'Window',
        id: 'menu_window',
        role: 'window',
        submenu: [
        {
            label: 'Minimize',
            id: 'minimize_window',
            role: 'minimize'
        },
        {
            label: 'Full Screen',
            id: 'fullscreen_window',
            role: 'togglefullscreen'
        },
        {
            label: 'Toggle Developer Tools',
            id: 'toggle_devel_tools',
            accelerator: (function() {
                if (process.platform == 'darwin')
                    return 'Alt+Command+I';
                else
                    return 'Ctrl+Shift+I';
            })(),
            click: function(item, focusedWindow) {
                if (focusedWindow)
                    focusedWindow.toggleDevTools();
            }
        }
        ]
    },
    {
        label: 'Help',
        id: 'menu_help',
        role: 'help',
        submenu: [
        {
            label: 'IF Reference Card',
            id: 'if_ref_card',
            enabled: (wintype != 'card'),
            click: function(item, win) {
                if (!cardwin)
                    open_card_window();
                else
                    cardwin.show();
            }
        }
        ]
    }
    ];

    if (isbound) {
        /* In bound-game mode, we knock the open options out of the
           File menu. */
        var stanza = find_in_template(template, 'menu_file');
        if (stanza) {
            var submenu = stanza.submenu;
            var pos = index_in_template(submenu, 'open_game');
            if (pos >= 0)
                submenu.splice(pos, 1);
            var pos = index_in_template(submenu, 'open_recent');
            if (pos >= 0)
                submenu.splice(pos, 1);
            if (submenu.length && submenu[0].type == 'separator')
                submenu.splice(0, 1);
        }
    }
    
    if (process.platform == 'darwin') {
        var stanza = find_in_template(template, 'menu_window');
        if (stanza) {
            stanza.submenu.push({ type: 'separator' });
        }

        template.unshift({
            label: name,
            submenu: [
            {
                label: 'About ' + name,
                id: 'about_app',
                enabled: (wintype != 'about'),
                click: function() {
                    if (!aboutwin)
                        open_about_window();
                    else
                        aboutwin.show();
                    aboutwin_initial = false;
                }
            },
            { type: 'separator' },
            {
                label: 'Services',
                role: 'services',
                submenu: []
            },
            { type: 'separator' },
            {
                label: 'Hide ' + name,
                accelerator: 'Command+H',
                role: 'hide'
            },
            {
                label: 'Hide Others',
                accelerator: 'Command+Alt+H',
                role: 'hideothers'
            },
            {
                label: 'Show All',
                role: 'unhide'
            },
            { type: 'separator' },
            {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: function() { app.quit(); }
            },
            ]
        });
    }
    else {
        /* Windows and Linux case: we construct a separate menu for every
           window. This lets us drop some menus entirely. */

        var stanza = find_in_template(template, 'menu_help');
        if (stanza) {
            stanza.submenu.push({
                label: 'About ' + name,
                id: 'about_app',
                enabled: (wintype != 'about'),
                click: function(item, win) {
                    if (!aboutwin)
                        open_about_window();
                    else
                        aboutwin.show();
                    aboutwin_initial = false;
                }
            });
        }

        if (!(isgame || istrashow)) {
            /* Drop the View menu for non-game/trashow windows. */
            var pos = index_in_template(template, 'menu_view');
            if (pos >= 0) {
                template.splice(pos, 1);
            }
        }
    }

    if (main_extension.construct_menu_template)
        template = main_extension.construct_menu_template(template, wintype);
    
    return template;
}

/* --------------------------------------------------------------------
   Begin app setup.
 */

/* Ensure that only one Lectrote process exists at a time. */

if (!app.requestSingleInstanceLock()) {
    /* Another process already exists. Our arguments have been sent
       to it. */
    app.quit();
    return;
}

app.on('second-instance', (event, argv, cwd) => {
    /* This callback arrives when a second process tries to launch.
       Its arguments are sent here. */
    var count = 0;
    for (var ix=1; ix<argv.length; ix++) {
        var path = argv[ix];
        if (path_mod.basename(path) == 'main.js' || path_mod.basename(path) == '.')
            continue;
        if (path.startsWith('-'))
            continue;
        if (!app_ready)
            launch_paths.push(path);
        else
            launch_game(path);
        count++;
    }

    if (!count) {
        /* The app was launched with no game arguments. To show willing,
           we'll pop up the about window. */
        if (!aboutwin) {
            open_about_window();
            aboutwin_initial = true;
        }
        else {
            aboutwin.show();
        }
    }
});

/* Set up handlers. */

/* Called when the last window is closed; we shut down.
*/
app.on('window-all-closed', function() {
    app.quit();
});

/* Called when the app is going to quit, either because the last window
   closed or the user hit cmd-Q. (This happens before windows close.)
*/
app.on('before-quit', function() {
    app_quitting = true;
});

/* Called when the app is quitting, either because the last window
   closed or the user hit cmd-Q. 
*/
app.on('will-quit', function() {
    check_autodelete_transcripts();
    write_prefs_now();
    stop_audio_engine();
});

electron.nativeTheme.on('updated', function() {
    for (var win of get_all_game_trashow_windows()) {
        invoke_app_hook(win, 'set_color_theme', { theme:prefs.gamewin_colortheme, darklight:electron.nativeTheme.shouldUseDarkColors });
    }
    if (prefswin)
        prefswin.webContents.send('set-darklight-mode', electron.nativeTheme.shouldUseDarkColors);
    if (aboutwin)
        aboutwin.webContents.send('set-darklight-mode', electron.nativeTheme.shouldUseDarkColors);
    if (cardwin)
        cardwin.webContents.send('set-darklight-mode', electron.nativeTheme.shouldUseDarkColors);
    if (transcriptwin)
        transcriptwin.webContents.send('set-darklight-mode', electron.nativeTheme.shouldUseDarkColors);
    if (main_extension.set_darklight_mode)
        main_extension.set_darklight_mode(electron.nativeTheme.shouldUseDarkColors);
});

electron.ipcMain.on('select_load_game', function() {
    if (isbound)
        return;
    select_load_game();
});

electron.ipcMain.on('select_load_recent', function() {
    if (isbound)
        return;
    var template = construct_recent_game_menu();
    if (!template || !template.length)
        return;
    var menu = electron.Menu.buildFromTemplate(template);
    menu.popup(aboutwin);
});

electron.ipcMain.handle('get_app_paths', function(ev) {
    var obj = {
        userData: app.getPath('userData'),
        temp: app.getPath('temp')
    };
    return obj;
});

electron.ipcMain.handle('dialog_open', function(ev, tosave, opts) {
    var game = game_for_webcontents(ev.sender);
    if (!game) {
        return null;
    }

    // The showDialog calls return a promise whose ultimate value becomes the RPC return value.
    if (!tosave) {
        return electron.dialog.showOpenDialog(game.win, opts);
    }
    else {
        return electron.dialog.showSaveDialog(game.win, opts);
    }
});

electron.ipcMain.on('game_metadata', function(ev, arg) {
    var game = game_for_webcontents(ev.sender);
    if (game) {
        if (arg.title)
            game.title = arg.title;
        if (arg.signature)
            game.signature = arg.signature;
        if (arg.coverimageres !== undefined)
            game.coverimageres = arg.coverimageres;

        // Bang the focus event to update the "Display Cover Art" menu item.
        window_focus_update(game.win, game);
    }
});

electron.ipcMain.on('open_transcript', function(ev, arg) {
    var tra = trashow_for_filename(arg);
    if (tra)
        tra.win.show();
    else
        open_transcript_display_window(arg);
});

electron.ipcMain.on('set_selected_transcript', function(ev, arg) {
    if (selected_transcript != arg) {
        selected_transcript = arg;
        
        // Bang the focus event to update the transcript menu items.
        window_focus_update(transcriptwin, null);
    }
});

electron.ipcMain.on('pref_font', function(ev, fontkey, customfont) {
    prefs.gamewin_font = fontkey;
    prefs.gamewin_customfont = customfont;
    note_prefs_dirty();
    for (var win of get_all_game_trashow_windows()) {
        invoke_app_hook(win, 'set_font', { font:prefs.gamewin_font, customfont:prefs.gamewin_customfont });
    }
});

electron.ipcMain.on('pref_color_theme', function(ev, arg) {
    prefs.gamewin_colortheme = arg;
    note_prefs_dirty();
    for (var win of get_all_game_trashow_windows()) {
        invoke_app_hook(win, 'set_color_theme', { theme:prefs.gamewin_colortheme, darklight:electron.nativeTheme.shouldUseDarkColors });
    }
});

electron.ipcMain.on('pref_margin_level', function(ev, arg) {
    prefs.gamewin_marginlevel = arg;
    note_prefs_dirty();
    for (var win of get_all_game_trashow_windows()) {
        invoke_app_hook(win, 'set_margin_level', prefs.gamewin_marginlevel);
    }
});

electron.ipcMain.on('pref_zoom_level', function(ev, arg) {
    prefs.gamewin_zoomlevel = arg;
    note_prefs_dirty();
    var val = zoom_factor_for_level(prefs.gamewin_zoomlevel);
    set_zoom_factor_all(val);
});

electron.ipcMain.on('pref_glulx_terp', function(ev, arg) {
    prefs.glulx_terp = arg;
    note_prefs_dirty();
});

electron.ipcMain.on('pref_traretain_for', function(ev, arg) {
    prefs.traretain_for = arg;
    note_prefs_dirty();
});

electron.ipcMain.on('pref_traretain_count', function(ev, arg) {
    prefs.traretain_count = arg;
    note_prefs_dirty();
});

electron.ipcMain.on('pref_traretain_daycount', function(ev, arg) {
    prefs.traretain_daycount = arg;
    note_prefs_dirty();
});

/* Speech prefs (from the prefs window). */

electron.ipcMain.on('pref_tts_enabled', function(ev, arg) {
    set_tts_enabled(arg);
});

electron.ipcMain.on('pref_tts_voice', function(ev, arg) {
    prefs.tts_voice = arg;
    note_prefs_dirty();
    broadcast_audio_prefs();
});

electron.ipcMain.on('pref_tts_speed', function(ev, arg) {
    var val = Number(arg);
    if (isNaN(val))
        return;
    prefs.tts_speed = Math.min(audioconfig.tts_speed_max, Math.max(audioconfig.tts_speed_min, val));
    note_prefs_dirty();
    broadcast_audio_prefs();
});

electron.ipcMain.on('pref_tts_speak_input', function(ev, arg) {
    prefs.tts_speak_input = (arg == true);
    note_prefs_dirty();
    broadcast_audio_prefs();
});

electron.ipcMain.on('pref_tts_fallback_os', function(ev, arg) {
    prefs.tts_fallback_os = (arg == true);
    note_prefs_dirty();
    broadcast_audio_prefs();
});

electron.ipcMain.on('pref_stt_enabled', function(ev, arg) {
    set_stt_enabled(arg);
});

electron.ipcMain.on('pref_stt_model', function(ev, arg) {
    if (!audioconfig.stt_model_for_key(arg))
        return;
    prefs.stt_model = arg;
    note_prefs_dirty();
    sync_audio_engine_loads();
    broadcast_audio_prefs();
});

electron.ipcMain.on('pref_stt_auto_submit', function(ev, arg) {
    prefs.stt_auto_submit = (arg == true);
    note_prefs_dirty();
    broadcast_audio_prefs();
});

electron.ipcMain.on('pref_stt_ptt_key', function(ev, arg) {
    if (!audioconfig.ptt_key_for_key(arg))
        return;
    prefs.stt_ptt_key = arg;
    note_prefs_dirty();
    broadcast_audio_prefs();
});

/* The prefs window's "Retry" button, after a model failed to load. */
electron.ipcMain.on('audio_retry_load', function(ev, arg) {
    if (!audio_available)
        return;
    /* Restart the engine from scratch; a failed download can leave it in
       a sulky state. */
    if (audioengine)
        stop_audio_engine();
    sync_audio_engine_loads();
});

electron.ipcMain.on('audio_show_model_dir', function(ev, arg) {
    var dir = audio_model_dir();
    try {
        fs.mkdirSync(dir, { recursive:true });
    }
    catch (ex) {}
    electron.shell.openPath(dir);
});

/* Speech traffic from the game windows. */

electron.ipcMain.on('speech_speak', function(ev, arg) {
    var game = game_for_webcontents(ev.sender);
    if (!game || !prefs.tts_enabled)
        return;
    if (!audioengine || !audioengine_ready)
        return;
    audioengine.postMessage({
        type: 'tts_speak',
        winid: game.id,
        jobid: arg.jobid,
        text: arg.text,
        voice: prefs.tts_voice,
        speed: prefs.tts_speed
    });
});

electron.ipcMain.on('speech_stop', function(ev, arg) {
    var game = game_for_webcontents(ev.sender);
    if (!game)
        return;
    if (!audioengine || !audioengine_ready)
        return;
    audioengine.postMessage({ type:'tts_stop', winid:game.id });
});

electron.ipcMain.on('speech_transcribe', function(ev, arg) {
    var game = game_for_webcontents(ev.sender);
    if (!game || !prefs.stt_enabled)
        return;
    if (!audioengine || !audioengine_ready) {
        invoke_app_hook(game.win, 'speech_stt_error', { reqid:arg.reqid, error:'Speech recognition is not running.' });
        return;
    }
    audioengine.postMessage({
        type: 'stt_transcribe',
        winid: game.id,
        reqid: arg.reqid,
        audio: arg.audio
    });
});

electron.ipcMain.on('search_done', function(ev, arg) {
    var obj = game_trashow_for_webcontents(ev.sender);
    if (!obj)
        return;
    search_cancel(obj);
});

electron.ipcMain.on('search_text', function(ev, arg) {
    var obj = game_trashow_for_webcontents(ev.sender);
    if (!obj)
        return;
    search_text(obj, arg);
});

electron.ipcMain.on('search_again', function(ev, arg) {
    var obj = game_trashow_for_webcontents(ev.sender);
    if (!obj)
        return;
    search_again(obj, arg);
});

/* Called at applicationWillFinishLaunching time (or before ready).
   Docs recommend setting up the open-file handler here.
*/
app.on('will-finish-launching', function() {
    try {
        var path = path_mod.join(__dirname, 'package.json');
        var val = fs.readFileSync(path, { encoding:'utf8' });
        package_json = JSON.parse(val);
    }
    catch (ex) { }

    if (package_json.lectroteMainExtension) {
        main_extension = require(path_mod.join(__dirname, package_json.lectroteMainExtension));
        if (main_extension.launch)
            main_extension.launch(package_json);
    }
        
    var boundpath = package_json.lectrotePackagedGame;
    if (boundpath) {
        /* We're in single-game mode. Do not handle command-line
           arguments or open-file events. Launch with the built-in
           path and no other. */
        isbound = true;
        bound_game_path = path_mod.join(__dirname, boundpath);
        launch_paths.push(bound_game_path);
        return;        
    }

    /* open-file events can come from the dock/taskbar, or (on MacOS)
       from the Finder handing us a double-clicked file. See 
       Lectrote.app/Contents/Info.plist for the definition of what
       file types the Finder will hand us. 

       This event can be received before ready time. If it is, then
       we have to stash the path for later use.
    */
    app.on('open-file', function(ev, path) {
        if (!app_ready)
            launch_paths.push(path);
        else
            launch_game(path);
    });

    /* If we were launched with "npm start game.ulx" then "game.ulx" is
       in process.argv. Unfortunately, the first argument may be "main.js"
       or not, depending on how we were launched. I don't know a way to
       distinguish this other than just special-casing "main.js".
       We also ignore any arguments starting with a dash; these appear on
       various platforms and I don't have a full list. */
    for (var ix=1; ix<process.argv.length; ix++) {
        var path = process.argv[ix];
        if (path_mod.basename(path) == 'main.js' || path_mod.basename(path) == '.')
            continue;
        if (path.startsWith('-'))
            continue;
        launch_paths.push(path);
    }
});

/* Called when Electron is initialized and ready to run. 
*/
app.on('ready', function() {
    app_ready = true;

    load_prefs();

    audio_available = check_audio_available();
    if (audio_available && (prefs.tts_enabled || prefs.stt_enabled)) {
        /* Start loading the speech models right away, so they're ready
           by the time a game is opened. */
        sync_audio_engine_loads();
    }

    if (process.platform != 'darwin' && process.platform != 'win32') {
        /* Mac windows don't have icons; Windows windows inherit their
           icon from the app's .ico resource. On Linux, we want to
           apply a generic icon. */
        window_icon = path_mod.join(__dirname, 'icon-128.png');
    }
    if (process.platform == 'win32') {
        /* On Windows, set the tray icon. */
        tray_icon = new electron.Tray(path_mod.join(__dirname, 'icon-tray.ico'));

        var traymenu = electron.Menu.buildFromTemplate([
            {
                label: 'Quit', click: function() { app.quit(); }
            }
        ]);
        tray_icon.setContextMenu(traymenu)
    }
    
    var template = construct_menu_template();
    var menu = electron.Menu.buildFromTemplate(template);
    electron.Menu.setApplicationMenu(menu);

    /* If any paths have been received, launch them. If not, open an
       initial splash window. (In bound-game mode, launch_paths should
       contain exactly one path.) */

    if (!launch_paths.length) {
        open_about_window();
        aboutwin_initial = true;
    }
    else {
        for (var ix=0; ix<launch_paths.length; ix++)
            launch_game(launch_paths[ix]);
    }

    /* Won't need this any more */
    launch_paths = null;

    if (main_extension.app_ready)
        main_extension.app_ready();
});

/* Export some API calls needed for extensions. */
exports.game_list = game_list;
exports.construct_menu_template = construct_menu_template;
exports.prefs_get = function(key) { return prefs[key]; };
exports.prefs_set = function(key, val) { prefs[key] = val; note_prefs_dirty(); };
exports.window_position_prefs = window_position_prefs;
exports.window_position_prefs_handler = window_position_prefs_handler;
exports.window_size_prefs = window_size_prefs;
exports.window_size_prefs_handler = window_size_prefs_handler;
exports.window_focus_update = window_focus_update;
exports.zoom_factor = function() { return zoom_factor_for_level(prefs.gamewin_zoomlevel); };
exports.is_app_ready = function() { return app_ready; };
exports.is_app_quitting = function() { return app_quitting; };
