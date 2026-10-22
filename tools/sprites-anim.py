# tools/sprites-anim.py —— 从「出去/回来」动画表里切帧
#
# 表是 2 行 × 6 列：上排「出发探险」向右走 + 一张举望远镜的「发现!」，
# 下排「满载而归」向左走 + 一张抱书的「回到营地」。
#
# 做法（跟 sprites.py 一路）：整张一次抠 → alpha 连通块找人 → 按行分组 → 按 x 排序 →
# 同一套缩放（帧与帧之间不能忽大忽小，否则走起来会抖）→ 底部对齐。
#
# 跑法：python tools/sprites-anim.py
from PIL import Image
from cutout import cut_image

SHEET = 'art-source/maid-anim-sheet.png'
OUT = 'art-source/frames'   # 单帧只是中间产物，进包的是拼好的雪碧图
SIZE = 192
MIN_AREA = 8000


def components(im, thresh=10):
    w, h = im.size
    a = im.getchannel('A').load()
    seen = bytearray(w * h)
    out = []
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if seen[i] or a[x, y] <= thresh:
                continue
            stack = [i]
            seen[i] = 1
            n = 0
            l = r = x
            t = b = y
            while stack:
                j = stack.pop()
                n += 1
                jy, jx = divmod(j, w)
                if jx < l: l = jx
                if jx > r: r = jx
                if jy < t: t = jy
                if jy > b: b = jy
                for nx, ny in ((jx - 1, jy), (jx + 1, jy), (jx, jy - 1), (jx, jy + 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        k = ny * w + nx
                        if not seen[k] and a[nx, ny] > thresh:
                            seen[k] = 1
                            stack.append(k)
            out.append({'area': n, 'box': (l, t, r + 1, b + 1)})
    out.sort(key=lambda c: -c['area'])
    return out


def main():
    cut = cut_image(Image.open(SHEET))
    w, h = cut.size
    # 面积 + 高度双筛：图上的说明文字（「出发探险」那几行）面积够但很矮，要排掉
    comps = [c for c in components(cut)
             if c['area'] >= MIN_AREA and (c['box'][3] - c['box'][1]) > h * 0.15]
    mid = h / 2
    rows = {
        'out': sorted([c for c in comps if c['box'][1] < mid], key=lambda c: c['box'][0]),
        'back': sorted([c for c in comps if c['box'][1] >= mid], key=lambda c: c['box'][0]),
    }
    for name, list_ in rows.items():
        print(f'{name}: 认到 {len(list_)} 帧')
        for i, c in enumerate(list_):
            print(f'   第 {i + 1} 帧 box={c["box"]} area={c["area"]}')

    # 所有帧用同一个缩放（取最高的那一帧做基准），底部对齐
    pieces = []
    for name, list_ in rows.items():
        for i, c in enumerate(list_):
            l, t, r, b = c['box']
            piece = cut.crop((max(0, l - 4), max(0, t - 4), min(w, r + 4), min(h, b + 4)))
            box = piece.getbbox()
            if box:
                piece = piece.crop(box)
            pieces.append((name, i + 1, piece))

    tallest = max(p.height for _, _, p in pieces)
    for name, idx, piece in pieces:
        scale = (SIZE * 0.96) / tallest
        rs = piece.resize((max(1, round(piece.width * scale)), max(1, round(piece.height * scale))), Image.LANCZOS)
        canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
        canvas.paste(rs, ((SIZE - rs.width) // 2, SIZE - rs.height), rs)
        canvas.save(f'{OUT}/anim-{name}-{idx}.png')
    print(f'共 {len(pieces)} 帧，已写到 {OUT}/anim-*.png')


if __name__ == '__main__':
    main()
