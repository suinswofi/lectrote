#!/usr/bin/env python3

# Usage: python3 makedist.py
#
# This script copies the working files (everything needed to run Lectrote)
# into prebuilt Electron app packages. Fetch these from
#    https://github.com/atom/electron/releases
# and unzip them into a "dist" directory.

import sys
import os, os.path
import optparse
import shutil
import json
import subprocess

all_packages = [
    'darwin-x64',
    'darwin-arm64',
    'darwin-universal',
    'linux-x64',
    'linux-arm64',
    'win32-ia32',
    'win32-x64',
    'win32-arm64',
]

popt = optparse.OptionParser()

popt.add_option('-b', '--build',
                action='store_true', dest='makedist',
                help='build dist directories')
popt.add_option('-z', '--zip',
                action='store_true', dest='makezip',
                help='turn dist directories into zip files')
popt.add_option('-n', '--none',
                action='store_true', dest='makenothing',
                help='do nothing except look at the arguments')
popt.add_option('-g', '--game', '--gamedir',
                action='store', dest='gamedir',
                help='directory for game-specific files')
popt.add_option('--macsign',
                action='store', dest='macsign',
                help='Apple Developer cert name')
popt.add_option('-v', '--version',
                action='store', dest='buildversion',
                default='1',
                help='build version (default 1)')
popt.add_option('--no-audio',
                action='store_true', dest='noaudio',
                help='omit the speech (TTS/STT) modules')

(opts, args) = popt.parse_args()


appfiles = [
    './package.json',
    './main.js',
    './apphooks.js',
    './traread.js',
    './tragen.js',
    './formats.js',
    './audioconfig.js',
    './audioengine.js',
    './speech.js',
    './play.html',
    './prefs.html',
    './prefs.js',
    './fonts.js',
    './searchbar.js',
    './about.html',
    './transcript.html',
    './transcript.js',
    './trashow.html',
    './trashow.js',
    './if-card.html',
    './if-card.js',
    './fonts.css',
    './play.css',
    './el-glkote.css',
    './font',  # all files
    './icon-128.png',
    './icon-tray.ico',
    './docicon-glulx.ico',
    './docicon-zcode.ico',
    './docicon-hugo.ico',
    './docicon-tads.ico',
    './docicon-json.ico',
    './quixe/lib/elkote.min.js',
    './quixe/lib/jquery-1.12.4.min.js',
    './quixe/lib/quixe.min.js',
    './quixe/media/waiting.gif',
    {
        'key': 'ifvms',
        'files': [
            './zplay.html',
            './ifvms/zvm.min.js',
            './ifvms/zvm_dispatch.min.js',
            './ifvms/gi_load.min.js',
            './ifvms/zvm.css',
            './ifvms/package.json',
        ]
    },
    {
        'key': 'emglken',
        'files': [
            './emglkenplay.html',
            'emglken/gi_load.min.js',
            'emglken/git-core.wasm',
            'emglken/git.js',
            'emglken/glulxe-core.wasm',
            'emglken/glulxe.js',
            'emglken/hugo-core.wasm',
            'emglken/hugo.js',
            'emglken/scare-core.wasm',
            'emglken/scare.js',
            'emglken/tads-core.wasm',
            'emglken/tads.js',
            'emglken/versions.json',
        ]
    },
    {
        'key': 'inkjs',
        'files': [
            './inkplay.html',
            './inkplay.js',
            './inkjs/ink.min.js',
            './inkjs/ink-130.min.js',
            './inkjs/ink-146.min.js',
            './inkjs/ink-160.min.js',
            './inkjs/package.json',
        ]
    },
]

rootfiles = [
    './LICENSE',    
    './LICENSES-FONTS.txt',
]

# The npm modules needed for the speech features (see audioengine.js).
# For each package we list just the files needed at runtime, since the
# packages contain a lot of dev/browser bulk. The ONNX runtime's native
# binaries are handled separately (one platform per build).
audio_modules = [
    ('kokoro-js', [ 'package.json', 'LICENSE', 'dist/kokoro.cjs', 'voices' ]),
    ('phonemizer', [ 'package.json', 'LICENSE', 'dist/phonemizer.cjs' ]),
    ('@huggingface/transformers', [ 'package.json', 'LICENSE', 'dist/transformers.node.cjs' ]),
    ('onnxruntime-common', [ 'package.json', 'dist/cjs' ]),
    ('onnxruntime-node', [ 'package.json', 'dist' ]),
]

# transformers.js requires the "sharp" image library at load time, even
# though we never process images. Rather than ship libvips for every
# platform, we install a stub which is truthy but throws if called.
sharp_stub = '''"use strict";
/* Stub for the sharp image library. Lectrote does not process images
   with transformers.js; this exists only so that require('sharp')
   succeeds. */
function sharp() {
    throw new Error('The sharp image library is not included in Lectrote.');
}
sharp.default = sharp;
module.exports = sharp;
'''

def copy_tree(src, dest):
    if os.path.isdir(src):
        shutil.copytree(src, dest, dirs_exist_ok=True)
    else:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(src, dest)

def audio_wanted(pkg, platform, arch):
    if opts.noaudio:
        return False
    if pkg.get('lectroteAudioFeatures') is False:
        return False
    if platform == 'win32' and arch == 'ia32':
        # onnxruntime-node has no 32-bit Windows binary.
        return False
    return True

def install_audio_modules(appdir, platform, arch):
    """Copy the speech modules into appdir/node_modules, with only the
    ONNX runtime binaries for the target platform.
    """
    destroot = os.path.join(appdir, 'node_modules')
    if os.path.exists(destroot):
        shutil.rmtree(destroot)

    for (name, files) in audio_modules:
        srcdir = os.path.join('node_modules', name)
        if not os.path.isdir(srcdir):
            raise Exception('audio module not installed (run npm install): ' + name)
        for filename in files:
            src = os.path.join(srcdir, filename)
            if not os.path.exists(src):
                raise Exception('audio module file missing: ' + src)
            copy_tree(src, os.path.join(destroot, name, filename))

    # The native ONNX runtime binaries for the target platform(s).
    if arch == 'universal':
        archls = [ 'x64', 'arm64' ]
    else:
        archls = [ arch ]
    for val in archls:
        bindir = os.path.join('napi-v3', platform, val)
        src = os.path.join('node_modules', 'onnxruntime-node', 'bin', bindir)
        if not os.path.isdir(src):
            raise Exception('no onnxruntime binaries for %s-%s: %s' % (platform, val, src))
        copy_tree(src, os.path.join(destroot, 'onnxruntime-node', 'bin', bindir))

    stubdir = os.path.join(destroot, 'sharp')
    os.makedirs(stubdir, exist_ok=True)
    fl = open(os.path.join(stubdir, 'package.json'), 'w')
    json.dump({ 'name':'sharp', 'version':'0.0.0-lectrote-stub', 'main':'index.js', 'license':'MIT' }, fl)
    fl.close()
    fl = open(os.path.join(stubdir, 'index.js'), 'w')
    fl.write(sharp_stub)
    fl.close()

    total = 0
    for (dirpath, dirnames, filenames) in os.walk(destroot):
        for filename in filenames:
            total += os.path.getsize(os.path.join(dirpath, filename))
    print('Speech modules for %s-%s: %.1f MB' % (platform, arch, total / 1048576.0))

def install(resourcedir, pkg):
    if not os.path.isdir(resourcedir):
        raise Exception('path does not exist: ' + resourcedir)
    appdir = resourcedir
    print('Installing to: ' + appdir)

    soleterp = pkg.get('lectroteSoleInterpreter')

    appfilesused = []
    for val in appfiles:
        if type(val) is dict:
            if soleterp and val['key'] != soleterp:
                continue
            for filename in val['files']:
                appfilesused.append(filename)
        else:
            appfilesused.append(val)
    
    os.makedirs(appdir, exist_ok=True)
    qdir = os.path.join(appdir, 'quixe')
    os.makedirs(qdir, exist_ok=True)
    os.makedirs(os.path.join(qdir, 'lib'), exist_ok=True)
    os.makedirs(os.path.join(qdir, 'media'), exist_ok=True)
    zvmdir = os.path.join(appdir, 'ifvms')
    os.makedirs(zvmdir, exist_ok=True)
    emglkendir = os.path.join(appdir, 'emglken')
    os.makedirs(emglkendir, exist_ok=True)
    inkdir = os.path.join(appdir, 'inkjs')
    os.makedirs(inkdir, exist_ok=True)

    for filename in appfilesused:
        srcfilename = filename
        if opts.gamedir:
            val = os.path.join(opts.gamedir, filename)
            if os.path.exists(val):
                srcfilename = val
        if not os.path.isdir(filename):
            shutil.copyfile(srcfilename, os.path.join(appdir, filename))
        else:
            subdirname = os.path.join(appdir, filename)
            os.makedirs(subdirname, exist_ok=True)
            for subfile in os.listdir(srcfilename):
                shutil.copyfile(os.path.join(srcfilename, subfile), os.path.join(subdirname, subfile))

    extrafiles = pkg.get('lectroteExtraFiles')
    if opts.gamedir and extrafiles:
        gamedir = os.path.join(appdir, os.path.basename(opts.gamedir))
        os.makedirs(gamedir, exist_ok=True)
        for filename in extrafiles:
            srcfilename = os.path.join(opts.gamedir, filename)
            if not os.path.isdir(filename):
                shutil.copyfile(srcfilename, os.path.join(gamedir, filename))
            else:
                subdirname = os.path.join(gamedir, filename)
                os.makedirs(subdirname, exist_ok=True)
                for subfile in os.listdir(srcfilename):
                    shutil.copyfile(os.path.join(srcfilename, subfile), os.path.join(subdirname, subfile))

def builddir(dir, pack, pkg):
    (platform, dummy, arch) = pack.partition('-')

    if audio_wanted(pkg, platform, arch):
        install_audio_modules('tempapp', platform, arch)
    else:
        val = os.path.join('tempapp', 'node_modules')
        if os.path.exists(val):
            shutil.rmtree(val)

    cmd = 'node_modules/.bin/electron-packager'
    args = [
        cmd, 'tempapp', product_name,
        '--app-version', product_version,
        '--build-version', opts.buildversion,
        '--arch='+arch, '--platform='+platform,
        '--out', 'dist',
        '--overwrite',
        '--no-prune'  # we curate node_modules ourselves; see install_audio_modules()
        ]

    if platform == 'darwin':
        appid = 'com.eblong.lectrote'
        if opts.gamedir:
            appid = pkg.get('lectroteMacAppID')
            if not appid:
                raise Exception('Mac package must set lectroteMacAppID')
            if appid == 'com.eblong.lectrote':
                raise Exception('lectroteMacAppID must not be com.eblong.lectrote')

        iconpath = 'resources/appicon-mac.icns'
        if opts.gamedir and os.path.exists(os.path.join(opts.gamedir, 'resources/appicon-mac.icns')):
            iconpath = os.path.join(opts.gamedir, 'resources/appicon-mac.icns')
        
        args = args + [
            '--app-bundle-id='+appid,
            '--app-category-type=public.app-category.games',
            '--icon='+iconpath,
            '--extra-resource=resources/icon-glulx.icns',
            '--extra-resource=resources/icon-zcode.icns',
            '--extra-resource=resources/icon-hugo.icns',
            '--extra-resource=resources/icon-tads.icns',
            '--extra-resource=resources/icon-blorb.icns',
            '--extra-resource=resources/icon-gblorb.icns',
            '--extra-resource=resources/icon-zblorb.icns',
            '--extra-resource=resources/icon-glksave.icns',
            '--extra-resource=resources/icon-glkdata.icns',
            '--extra-resource=resources/icon-json.icns',
            '--extend-info', 'resources/Add-Info.plist',
            ]
        if opts.macsign:
            args = args + [
                '--osx-sign.entitlements', 'resources/mac-app.entitlements',
                '--osx-sign.entitlements-inherit', 'resources/mac-app.entitlements',
                '--osx-sign.identity', opts.macsign,
                '--osx-sign.hardenedRuntime', 'true',
            ]

    if platform == 'win32':
        iconpath = 'resources/appicon-win.ico'
        if opts.gamedir and os.path.exists(os.path.join(opts.gamedir, 'resources/appicon-win.ico')):
            iconpath = os.path.join(opts.gamedir, 'resources/appicon-win.ico')

        filedesc = 'Interactive Fiction Interpreter'
        if opts.gamedir and pkg.get('description'):
            filedesc = pkg.get('description')

        if not opts.gamedir:
            companyname = 'Zarfhome Software'
        else:
            companyname = pkg.get('lectroteCompanyName')
        if companyname:
            args.append('--win32metadata.CompanyName='+companyname)

        if not opts.gamedir:
            copyright = 'Copyright 2016 by Andrew Plotkin'
        else:
            copyright = pkg.get('lectroteCopyright')
        if copyright:
            args.append('--app-copyright='+copyright)
        
        args = args + [
            '--win32metadata.InternalName='+product_name,
            '--win32metadata.ProductName='+product_name,
            '--win32metadata.OriginalFilename='+product_name+'.exe',
            '--win32metadata.FileDescription='+filedesc,
            '--icon='+iconpath,
            ]
        
    res = subprocess.call(args)
    if res:
        raise Exception('electron-packager failed')

    for filename in rootfiles:
        shutil.copyfile(filename, os.path.join(dir, filename))
    val = os.path.join(dir, 'version')
    if os.path.exists(val):
        os.unlink(val)

        
def makezip(dir, unwrapped=False):
    prefix = product_name + '-'
    val = os.path.split(dir)[-1]
    if not val.startswith(prefix):
        raise Exception('path does not have the prefix')
    platform = val[len(prefix):]
    zipfile = product_name + '-' + product_version + '-' + platform
    zipargs = '-q'
    if 'darwin' in zipfile:
        zipfile = zipfile.replace('darwin', 'macos')
        print('AppDMGing up: %s to %s' % (dir, zipfile))
        specfile = 'resources/create-dmg-args.txt'
        if opts.gamedir and os.path.exists(os.path.join(opts.gamedir, specfile)):
            specfile = os.path.join(opts.gamedir, specfile)
        quotargs = open(specfile).read().strip()
        subprocess.call('rm -f "dist/%s.dmg"; create-dmg %s "dist/%s.dmg" "%s"' % (zipfile, quotargs, zipfile, dir),
                        shell=True)
        return
    print('Zipping up: %s to %s (%s)' % (dir, zipfile, ('unwrapped' if unwrapped else 'wrapped')))
    if unwrapped:
        subprocess.call('cd "%s"; rm -f "../%s.zip"; zip "%s" -r "../%s.zip" *' % (dir, zipfile, zipargs, zipfile),
                        shell=True)
    else:
        dirls = os.path.split(dir)
        subdir = dirls[-1]
        topdir = os.path.join(*os.path.split(dir)[0:-1])
        subprocess.call('cd "%s"; rm -f "%s.zip"; zip "%s" -r "%s.zip" "%s"' % (topdir, zipfile, zipargs, zipfile, subdir),
                        shell=True)
    if 'win32-x64' in zipfile:
        print('Also creating nsis installer')
        args = [ 'makensis', '-dVERSION='+product_version, 'resources/wininstaller.nsi' ]
        subprocess.call(args)

# Start work! First, read the version string out of package.json.

pkgfile = 'package.json'
if opts.gamedir and os.path.exists(os.path.join(opts.gamedir, 'package.json')):
    pkgfile = os.path.join(opts.gamedir, 'package.json')
fl = open(pkgfile)
pkg = json.load(fl)
fl.close()

product_version = pkg['version']
product_name = pkg['productName'];
print('%s version: %s' % (product_name, product_version,))
if product_name != 'Lectrote':
    print('%s version: %s' % ('Lectrote', pkg['lectroteVersion'],))

# Decide what distributions we're working on. ("packages" is a bit overloaded,
# sorry.)

packages = []
if not args:
    packages = all_packages
else:
    for pack in all_packages:
        for arg in args:
            if arg in pack:
                packages.append(pack)
                break

if not packages:
    raise Exception('no packages selected')

os.makedirs('tempapp', exist_ok=True)
install('tempapp', pkg)

os.makedirs('dist', exist_ok=True)

doall = not (opts.makedist or opts.makezip or opts.makenothing)

if doall or opts.makedist:
    for pack in packages:
        dest = 'dist/%s-%s' % (product_name, pack,)
        builddir(dest, pack, pkg)

if doall or opts.makezip:
    for pack in packages:
        dest = 'dist/%s-%s' % (product_name, pack,)
        makezip(dest, unwrapped=('win32' in pack))
