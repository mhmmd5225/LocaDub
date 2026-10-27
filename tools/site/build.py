"""Tanıtım sayfası için indirilebilir eklenti paketini hazırlar.

site/LocaDub.zip  — extension/ klasörü, içinde LocaDub/ adlı tek klasörle
site/version.json — {"version", "bytes", "commit"}; sayfa sürüm ve boyutu buradan okur
site/app/ext/     — web uygulamasının (site/app/) eklentiden aldığı motorlar ve saf modüller

Netlify, GitHub Actions ve yerel derleme aynı betiği kullanır:  python tools/site/build.py
"""
import json
import os
import shutil
import subprocess
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXT = os.path.join(ROOT, 'extension')
SITE = os.path.join(ROOT, 'site')
ZIP = os.path.join(SITE, 'LocaDub.zip')
APP_EXT = os.path.join(SITE, 'app', 'ext')
# Web uygulaması bu dosyaları eklentiyle paylaşır; depoda tek kopya (extension/) tutulur.
APP_SHARED = ['engines', 'lib', 'common/pcm.js', 'common/settings.js',
              'content/captions.js', 'content/timing.js', 'content/player.js']


def commit():
    sha = os.environ.get('COMMIT_REF') or os.environ.get('GITHUB_SHA')  # Netlify / GitHub Actions
    if not sha:
        try:
            sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        except (OSError, subprocess.CalledProcessError):
            sha = ''
    return sha[:7]


def copy_app_ext():
    shutil.rmtree(APP_EXT, ignore_errors=True)
    for rel in APP_SHARED:
        src, dst = os.path.join(EXT, rel), os.path.join(APP_EXT, rel)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)


def main():
    copy_app_ext()
    with zipfile.ZipFile(ZIP, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for base, dirs, files in os.walk(EXT):
            dirs.sort()
            for name in sorted(files):
                path = os.path.join(base, name)
                z.write(path, os.path.join('LocaDub', os.path.relpath(path, EXT)).replace(os.sep, '/'))
    with open(os.path.join(EXT, 'manifest.json'), encoding='utf-8') as f:
        version = json.load(f)['version']
    info = {'version': version, 'bytes': os.path.getsize(ZIP), 'commit': commit()}
    with open(os.path.join(SITE, 'version.json'), 'w', encoding='utf-8') as f:
        json.dump(info, f)
    print(json.dumps(info))


if __name__ == '__main__':
    main()
