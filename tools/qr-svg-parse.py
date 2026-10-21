# tools/qr-svg-parse.py —— 把一个 SVG 解析回格子网格（只认 lib/qr.mjs 生成的那种路径）
# 用来验证"画出来的东西"和"算出来的矩阵"是同一个，而不是只看矩阵对不对。
import sys
import re
import xml.etree.ElementTree as ET

svg = open(sys.argv[1], encoding='utf8').read()
root = ET.fromstring(svg)
_, _, w, h = root.get('viewBox').split()
W, H = int(float(w)), int(float(h))
if W != H:
    raise SystemExit('viewBox 不是正方形')

grid = [[0] * W for _ in range(W)]
path = root.find('{http://www.w3.org/2000/svg}path').get('d')
tok = re.findall(r'[A-Za-z]|-?\d+', path)

x = y = 0
k = 0
runs = 0
while k < len(tok):
    t = tok[k]
    if t == 'M':
        x, y = int(tok[k + 1]), int(tok[k + 2])
        k += 3
    elif t in ('h', 'H'):
        n = int(tok[k + 1])
        if n > 0:
            for dx in range(n):
                grid[y][x + dx] = 1
            runs += 1
        x += n
        k += 2
    elif t in ('v', 'V'):
        y += int(tok[k + 1])
        k += 2
    elif t in ('z', 'Z'):
        k += 1
    else:
        raise SystemExit('不认识的路径指令：' + t)

print('\n'.join(''.join('#' if v else '.' for v in row) for row in grid))
sys.stderr.write('runs=%d\n' % runs)
