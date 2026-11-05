#!/usr/bin/env python3
"""ort-wasm-simd-threaded.jsep.mjs: embind `_emval_get_method_caller` kod üretip `new Function` ile derliyordu; MV3 eklenti
CSP'si ('unsafe-eval' yok) bunu engeller ve WebNN oturumu kurulamaz. Bu betik aynı sözleşmeyi kapanışla (closure) uygular.
ort sürümü yükseltilince yeniden çalıştırın:  python3 tools/patch-ort-csp.py [dosya]
Orijinal metin bulunamazsa hata verir (sürüm değişmiş olabilir); zaten yamalıysa bir şey yapmaz."""
import os
import sys

DEFAULT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'extension', 'lib', 'ort', 'ort-wasm-simd-threaded.jsep.mjs')
MARK = '/*locadub-csp*/'
OLD = 'a=ee(l)(...m);c=`methodCaller<'
# a: argüman sayısı, b: [argTürleri], c: kip (0: func.call(obj, ...), 1: new func(...), 2: func.call(arg0, ...)), d: dönüş türü
NEW = (MARK + 'a=((n,ty,mode,ret)=>function(obj,func,destructorsRef,args){var v=[],g=0;'
       'for(var p=0;p<n;++p){v.push(ty[p].readValueFromPointer(args+g));g+=ty[p].Db}'
       'var k=0===mode?[obj,...v]:v;var rv=1===mode?new func(...k):func.call(...k);'
       'if(!ret.Ub)return Gd(ret,destructorsRef,rv)})(a,b,c,d);c=`methodCaller<')


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    s = open(path, encoding='utf8').read()
    if MARK in s:
        print('zaten yamalı:', path)
        return 0
    if s.count(OLD) != 1:
        print('HATA: beklenen metin bulunamadı (ort sürümü değişmiş olabilir):', path, file=sys.stderr)
        return 1
    open(path, 'w', encoding='utf8', newline='').write(s.replace(OLD, NEW))
    print('yamalandı:', path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
