"""Tanıtım sayfası için indirilebilir eklenti paketini hazırlar.

site/LocaDub.zip  — extension/ klasörü, içinde LocaDub/ adlı tek klasörle
site/version.json — {"version", "bytes", "commit"}; sayfa sürüm ve boyutu buradan okur

Netlify, GitHub Actions ve yerel derleme aynı betiği kullanır:  python tools/site/build.py
"""
import json
import os
import subprocess
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXT = os.path.join(ROOT, 'extension')
SITE = os.path.join(ROOT, 'site')
ZIP = os.path.join(SITE, 'LocaDub.zip')


def commit():
    sha = os.environ.get('COMMIT_REF') or os.environ.get('GITHUB_SHA')  # Netlify / GitHub Actions
    if not sha:
        try:
            sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        except (OSError, subprocess.CalledProcessError):
            sha = ''
    return sha[:7]


def main():
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
