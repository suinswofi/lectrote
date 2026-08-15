'use strict';
const electron = require('electron');

const fonts = require('./fonts.js');
const formats = require('./formats.js');
const audioconfig = require('./audioconfig.js');

/* Code for the Preferences window. */

const tablist = [ 'appear', 'terp', 'tra', 'audio' ];

var darklight_flag = false;
var audio_available = false;
var last_audio_status = null; /* the audio_status object from main.js */

/* Set up the initial appearance of the window. This adjusts the controls
   and the sample text, but does not send changes to the app (because there
   have been no changes yet).
*/
function setup_with_prefs(prefs, isbound, arg)
{
    var sel, optel;
    audio_available = (arg && arg.audioavailable) ? true : false;

    // Function-calling function because closures suck.
    var setclick = function(val) {
        $('#tabbutton-'+val).on('click', function(ev) { 
            set_tab(val); 
            ev.preventDefault();
        });
    }
    for (var ix=0; ix<tablist.length; ix++) {
        setclick(tablist[ix]);
    }
    set_tab('appear');


    sel = $('#sel-color-theme');
    sel.prop('disabled', false);
    sel.empty();

    for (var ix=0; ix<themelist.length; ix++) {
        var theme = themelist[ix];
        optel = $('<option>', { value:theme.key }).text(theme.label);
        if (prefs.gamewin_colortheme == theme.key)
            optel.prop('selected', true);
        sel.append(optel);
    }

    sel.on('change', evhan_color_theme);
    apply_color_theme(prefs.gamewin_colortheme);


    sel = $('#sel-font');
    sel.prop('disabled', false);
    sel.empty();

    for (var ix=0; ix<fontlist.length; ix++) {
        var font = fontlist[ix];
        optel = $('<option>', { value:font.key }).text(font.label);
        if (prefs.gamewin_font == font.key)
            optel.prop('selected', true);
        sel.append(optel);
    }

    sel.on('change', evhan_font);

    var inpel = $('#input-font');
    if (prefs.gamewin_customfont)
        inpel.val(prefs.gamewin_customfont);
    inpel.on('change', evhan_font);

    apply_font(prefs.gamewin_font, prefs.gamewin_customfont);


    sel = $('#range-margin');
    sel.attr('step', 1);
    sel.attr('min', 0);
    sel.attr('max', 7);

    sel.on('input', evhan_margin_level);
    sel.val(prefs.gamewin_marginlevel);
    apply_margin_level(prefs.gamewin_marginlevel);


    sel = $('#range-zoom');
    sel.attr('step', 1);
    sel.attr('min', -6);
    sel.attr('max', 6);

    sel.on('input', evhan_zoom_level);
    sel.val(prefs.gamewin_zoomlevel);
    apply_zoom_level(prefs.gamewin_zoomlevel);


    if (!isbound) {
        sel = $('#sel-glulx-terp');
        sel.prop('disabled', false);
        sel.empty();

        for (var ix=0; ix<formats.formatmap['glulx'].engines.length; ix++) {
            var engine = formats.formatmap['glulx'].engines[ix];
            optel = $('<option>', { value:engine.id }).text(engine.name);
            if (prefs.glulx_terp == engine.id)
                optel.prop('selected', true);
            sel.append(optel);
        }

        sel.on('change', evhan_glulx_terp);
    }
    else {
        /* A bound game only gets the Appearance tab (and Audio, if
           available). */
        $('#tabbutton-terp').hide();
        $('#tabbutton-tra').hide();
        if (!audio_available) {
            sel = $('#tabheader');
            sel.hide();
        }
    }

    for (var val of [ 'forever', 'count', 'time' ]) {
        sel = $('#retaintra-'+val);
        if (prefs.traretain_for == val) 
            sel.prop('checked', true);
        sel.on('change', { for:val }, evhan_retain_transcripts);
    }
    
    sel = $('#retain-count');
    sel.prop('value', prefs.traretain_count);
    sel.on('change', evhan_retain_count);
    
    sel = $('#retain-daycount');
    sel.prop('value', prefs.traretain_daycount);
    sel.on('change', evhan_retain_daycount);

    setup_audio_prefs(prefs, arg);
}

/* Set up the Audio tab. */
function setup_audio_prefs(prefs, arg)
{
    var sel, optel;

    if (!audio_available) {
        $('#tabbutton-audio').hide();
        $('#audio-unavailable').show();
        $('#audio-controls').hide();
        return;
    }

    sel = $('#check-tts');
    sel.prop('checked', prefs.tts_enabled ? true : false);
    sel.on('change', evhan_tts_enabled);

    sel = $('#sel-tts-voice');
    sel.prop('disabled', false);
    sel.empty();
    for (var voice of audioconfig.tts_voices) {
        optel = $('<option>', { value:voice.id }).text(voice.label);
        if (prefs.tts_voice == voice.id)
            optel.prop('selected', true);
        sel.append(optel);
    }
    sel.on('change', evhan_tts_voice);

    sel = $('#range-tts-speed');
    sel.attr('min', audioconfig.tts_speed_min);
    sel.attr('max', audioconfig.tts_speed_max);
    sel.attr('step', audioconfig.tts_speed_step);
    sel.val(prefs.tts_speed);
    sel.on('input', evhan_tts_speed);
    apply_tts_speed(prefs.tts_speed);

    sel = $('#check-tts-speak-input');
    sel.prop('checked', prefs.tts_speak_input ? true : false);
    sel.on('change', evhan_tts_speak_input);

    sel = $('#check-tts-fallback');
    sel.prop('checked', prefs.tts_fallback_os ? true : false);
    sel.on('change', evhan_tts_fallback);

    sel = $('#check-stt');
    sel.prop('checked', prefs.stt_enabled ? true : false);
    sel.on('change', evhan_stt_enabled);

    sel = $('#sel-stt-model');
    sel.prop('disabled', false);
    sel.empty();
    for (var model of audioconfig.stt_models) {
        optel = $('<option>', { value:model.key }).text(model.label);
        if (prefs.stt_model == model.key)
            optel.prop('selected', true);
        sel.append(optel);
    }
    sel.on('change', evhan_stt_model);

    sel = $('#sel-stt-ptt');
    sel.prop('disabled', false);
    sel.empty();
    for (var ptt of audioconfig.ptt_keys) {
        optel = $('<option>', { value:ptt.key }).text(ptt.label);
        if (prefs.stt_ptt_key == ptt.key)
            optel.prop('selected', true);
        sel.append(optel);
    }
    sel.on('change', evhan_stt_ptt);

    /* The custom-key field: click it and press the key (or key combo)
       you want. */
    var inpel = $('#input-stt-ptt');
    inpel.on('keydown', evhan_stt_ptt_capture);
    inpel.on('focus', function() {
        inpel.val('');
        inpel.attr('placeholder', 'Press a key or combination…');
    });
    inpel.on('blur', function() {
        inpel.attr('placeholder', 'Click here, then press a key');
        if (prefs_ptt_key == 'custom' && !prefs_ptt_custom) {
            /* Nothing was captured; go back to the key actually in
               effect. */
            $('#sel-stt-ptt').val(confirmed_ptt_key);
            apply_stt_ptt(confirmed_ptt_key, null);
            return;
        }
        apply_stt_ptt(prefs_ptt_key, prefs_ptt_custom);
    });
    confirmed_ptt_key = prefs.stt_ptt_key;
    apply_stt_ptt(prefs.stt_ptt_key, prefs.stt_ptt_custom);

    sel = $('#check-stt-autosubmit');
    sel.prop('checked', prefs.stt_auto_submit ? true : false);
    sel.on('change', evhan_stt_autosubmit);

    if (arg && arg.modeldir)
        $('#display-model-dir').text(arg.modeldir);
    $('#btn-show-models').on('click', function(ev) {
        ev.preventDefault();
        electron.ipcRenderer.send('audio_show_model_dir');
    });

    last_audio_status = (arg ? arg.audiostatus : null);
    apply_audio_status(last_audio_status);
}

function set_tab(val)
{
    for (var tab of tablist) {
        var cls = 'CurrentTab' + tab.charAt(0).toUpperCase() + tab.slice(1);
        if (tab == val)
            $('body').addClass(cls);
        else
            $('body').removeClass(cls);
    }
}

/* The apply_... functions adjust the sample text in this window, but
   do not directly affect the controls or send changes to the app.

   A lot of this code is copied from apphooks.js. It has to be kept
   in sync.
*/

var themelist = [
    { key:'lightdark', label:'System (Light/Dark)' },
    { key:'sepiaslate', label:'System (Sepia/Slate)' },
    { key:'light', label:'Light' },
    { key:'sepia', label:'Sepia' },
    { key:'slate', label:'Slate' },
    { key:'dark', label:'Dark' }
];

function apply_color_theme(val)
{
    // System-reactive themes:
    if (val == 'lightdark') {
        val = (darklight_flag ? 'dark' : 'light');
    }
    else if (val == 'sepiaslate') {
        val = (darklight_flag ? 'slate' : 'sepia');
    }

    var bodyel = $('.Sample');

    bodyel.removeClass('SepiaTheme');
    bodyel.removeClass('SlateTheme');
    bodyel.removeClass('DarkTheme');

    switch (val) {

    case 'sepia':
        bodyel.addClass('SepiaTheme');
        break;

    case 'slate':
        bodyel.addClass('SlateTheme');
        break;

    case 'dark':
        bodyel.addClass('DarkTheme');
        break;

    default:
        /* Light theme is the default. */
        break;
    }
}

var fontlist = [
    { key:'lora', label:'Lora' },
    { key:'gentium', label:'Gentium Book' },
    { key:'georgia', label:'Georgia' },
    { key:'baskerville', label:'Libre Baskerville' },
    { key:'helvetica', label:'Helvetica' },
    { key:'sourcesanspro', label:'Source Sans Pro' },
    { key:'courier', label:'Courier' },
    { key:'custom', label:'Other Font...' }
];

function apply_font(fontkey, customfont)
{
    var inpel = $('#input-font');

    if (fontkey == 'custom') {
        if (inpel.css('display') != 'inline-block') {
            inpel.css('display', 'inline-block');
            inpel.select();
            inpel.focus();
        }
    }
    else {
        if (inpel.css('display') != 'none') {
            inpel.css('display', 'none');
        }
    }

    //### check if anything's changed
    var fontline = fonts.get_fontline(fontkey, customfont);

    var el = $('#fontcss');
    if (!fontline) {
        el.remove();
    }
    else {
        if (!el.length) {
            el = $('<style>', { id:'fontcss', type:'text/css' });
            $('#bodycss').before(el);
        }
        var text = '.Sample { font-family: @@; }\n';
        text = text.replace(/@@/g, fontline);
        el.text(text);
    }
}

function apply_margin_level(val)
{
    var str = '0px ' + (5*val) + '%';
    $('.SampleText').css({'margin':str});

    var el = $('#display-margin');
    var text = 'None';
    if (val > 0)
        text = (val*5) + '%';
    el.text(text);
}

function apply_zoom_level(val)
{
    var factor = 1;
    if (val)
        factor = Math.exp(val * 0.09531017980432493);

    $('.SampleText').css({'font-size':factor+'em'});

    var el = $('#display-zoom');
    var text = 'Normal';
    if (val > 0)
        text = 'Zoom In ' + val;
    else if (val < 0)
        text = 'Zoom Out ' + (-val);
    el.text(text);
}

/* Remembered so the custom-key field can be refreshed. */
var prefs_ptt_key = null;
var prefs_ptt_custom = null;
var confirmed_ptt_key = null; /* the key the app says is in effect */

/* Show or hide the custom-key field, and show the current custom key
   in it. */
function apply_stt_ptt(key, custom)
{
    prefs_ptt_key = key;
    prefs_ptt_custom = custom;
    var inpel = $('#input-stt-ptt');
    if (key == 'custom') {
        inpel.css('display', 'inline-block');
        if (custom && custom.label)
            inpel.val(custom.label);
        else
            inpel.val('');
    }
    else {
        inpel.css('display', 'none');
    }
}

function apply_tts_speed(val)
{
    var el = $('#display-tts-speed');
    var num = Number(val);
    if (isNaN(num))
        num = 1.0;
    el.text(num.toFixed(2).replace(/0$/, '') + '\u00D7');
}

/* Show what the speech models are up to (loading, downloading, ready,
   failed). Called with the audio_status object from main.js. */
function apply_audio_status(status)
{
    var checks = { tts:$('#check-tts'), stt:$('#check-stt') };
    for (var key of ['tts', 'stt']) {
        var el = $('#status-'+key);
        el.empty();
        el.removeClass('Error');
        var state = (status && status[key]) ? status[key] : null;
        var enabled = checks[key].prop('checked');
        var text = '';
        if (!enabled) {
            text = '';
        }
        else if (!state || state.status == 'unloaded') {
            text = 'Starting the speech engine\u2026';
        }
        else if (state.status == 'loading') {
            text = 'Loading the model\u2026';
        }
        else if (state.status == 'downloading') {
            text = 'Downloading the model (first time only)\u2026';
            if (state.pct !== null && state.pct !== undefined) {
                el.text(text);
                var progel = $('<progress>', { max:100, value:state.pct });
                el.append(progel);
                el.append($('<span>').text(' ' + state.pct + '%'));
                continue;
            }
        }
        else if (state.status == 'ready') {
            text = 'Ready.';
        }
        else if (state.status == 'error') {
            el.addClass('Error');
            el.text('Could not load the model: ' + (state.error || 'unknown error'));
            var btn = $('<button>').text('Retry');
            btn.on('click', function(ev) {
                ev.preventDefault();
                electron.ipcRenderer.send('audio_retry_load');
            });
            el.append(btn);
            continue;
        }
        el.text(text);
    }
}

function apply_darklight(val)
{
    darklight_flag = val;
    
    var el = $('body');
    if (!darklight_flag) {
        el.addClass('LightMode');
        el.removeClass('DarkMode');
    }
    else {
        el.addClass('DarkMode');
        el.removeClass('LightMode');
    }
    
    var sel = $('#sel-color-theme');
    var val = sel.val();
    apply_color_theme(val);
}

/* The evhan_... functions respond to user manipulation of the controls.
   They invoke apply_... to adjust the sample text, and then send a
   pref update to the app. */

function evhan_color_theme()
{
    var sel = $('#sel-color-theme');
    var val = sel.val();
    apply_color_theme(val);
    electron.ipcRenderer.send('pref_color_theme', val);
}

function evhan_font()
{
    var fontkey = $('#sel-font').val();
    var customfont = $('#input-font').val();
    apply_font(fontkey, customfont);
    electron.ipcRenderer.send('pref_font', fontkey, customfont);
}

function evhan_margin_level()
{
    var sel = $('#range-margin');
    var val = Math.round(1 * sel.val()); /* cast to int */
    apply_margin_level(val);
    electron.ipcRenderer.send('pref_margin_level', val);
}

function evhan_zoom_level()
{
    var sel = $('#range-zoom');
    var val = Math.round(1 * sel.val()); /*cast to int */
    apply_zoom_level(val);
    electron.ipcRenderer.send('pref_zoom_level', val);
}

function evhan_glulx_terp()
{
    var sel = $('#sel-glulx-terp');
    var val = sel.val();
    electron.ipcRenderer.send('pref_glulx_terp', val);
}

function evhan_retain_transcripts(ev)
{
    electron.ipcRenderer.send('pref_traretain_for', ev.data.for);
}

function evhan_retain_count()
{
    var sel = $('#retain-count');
    var val = sel.prop('value');
    electron.ipcRenderer.send('pref_traretain_count', 1*val);
}

function evhan_retain_daycount()
{
    var sel = $('#retain-daycount');
    var val = sel.prop('value');
    electron.ipcRenderer.send('pref_traretain_daycount', 1*val);
}

function evhan_tts_enabled()
{
    var val = $('#check-tts').prop('checked');
    electron.ipcRenderer.send('pref_tts_enabled', val);
}

function evhan_tts_voice()
{
    var val = $('#sel-tts-voice').val();
    electron.ipcRenderer.send('pref_tts_voice', val);
}

function evhan_tts_speed()
{
    var val = Number($('#range-tts-speed').val());
    apply_tts_speed(val);
    electron.ipcRenderer.send('pref_tts_speed', val);
}

function evhan_tts_speak_input()
{
    var val = $('#check-tts-speak-input').prop('checked');
    electron.ipcRenderer.send('pref_tts_speak_input', val);
}

function evhan_tts_fallback()
{
    var val = $('#check-tts-fallback').prop('checked');
    electron.ipcRenderer.send('pref_tts_fallback_os', val);
}

function evhan_stt_enabled()
{
    var val = $('#check-stt').prop('checked');
    electron.ipcRenderer.send('pref_stt_enabled', val);
}

function evhan_stt_model()
{
    var val = $('#sel-stt-model').val();
    electron.ipcRenderer.send('pref_stt_model', val);
}

function evhan_stt_ptt()
{
    var val = $('#sel-stt-ptt').val();
    if (val == 'custom') {
        /* Only tell the app once a key has actually been captured;
           until then the previous key stays in effect. */
        apply_stt_ptt('custom', prefs_ptt_custom);
        if (!prefs_ptt_custom)
            $('#input-stt-ptt').focus();
        else
            electron.ipcRenderer.send('pref_stt_ptt_key', val);
        return;
    }
    apply_stt_ptt(val, prefs_ptt_custom);
    electron.ipcRenderer.send('pref_stt_ptt_key', val);
}

function evhan_stt_ptt_capture(ev)
{
    ev.preventDefault();
    ev.stopPropagation();
    var orig = ev.originalEvent || ev;
    if (orig.key == 'Escape' || orig.key == 'Tab') {
        $('#input-stt-ptt').blur();
        return;
    }
    var spec = audioconfig.ptt_spec_from_event(orig);
    if (!spec)
        return;
    prefs_ptt_custom = spec;
    prefs_ptt_key = 'custom';
    $('#input-stt-ptt').val(spec.label);
    electron.ipcRenderer.send('pref_stt_ptt_custom', spec);
    $('#input-stt-ptt').blur();
}

function evhan_stt_autosubmit()
{
    var val = $('#check-stt-autosubmit').prop('checked');
    electron.ipcRenderer.send('pref_stt_auto_submit', val);
}

/* Respond to messages from the app. */

electron.ipcRenderer.on('set-darklight-mode', function(ev, arg) {
    apply_darklight(arg);
});
electron.ipcRenderer.on('current-prefs', function(ev, arg) {
    setup_with_prefs(arg.prefs, arg.isbound, arg);
});
electron.ipcRenderer.on('set-zoom-level', function(ev, arg) {
    $('#range-zoom').val(arg);
    apply_zoom_level(arg);
});

/* The speech prefs changed somewhere else (a menu toggle, say). */
electron.ipcRenderer.on('set-audio-prefs', function(ev, arg) {
    if (!audio_available)
        return;
    $('#check-tts').prop('checked', arg.tts_enabled ? true : false);
    $('#sel-tts-voice').val(arg.tts_voice);
    $('#range-tts-speed').val(arg.tts_speed);
    apply_tts_speed(arg.tts_speed);
    $('#check-tts-speak-input').prop('checked', arg.tts_speak_input ? true : false);
    $('#check-tts-fallback').prop('checked', arg.tts_fallback_os ? true : false);
    $('#check-stt').prop('checked', arg.stt_enabled ? true : false);
    $('#sel-stt-model').val(arg.stt_model);
    $('#sel-stt-ptt').val(arg.stt_ptt_key);
    confirmed_ptt_key = arg.stt_ptt_key;
    apply_stt_ptt(arg.stt_ptt_key, arg.stt_ptt_custom);
    $('#check-stt-autosubmit').prop('checked', arg.stt_auto_submit ? true : false);
    apply_audio_status(last_audio_status);
});
electron.ipcRenderer.on('audio-status', function(ev, arg) {
    last_audio_status = arg;
    if (!audio_available)
        return;
    apply_audio_status(arg);
});
