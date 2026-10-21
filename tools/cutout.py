# tools/cutout.py —— 把「假透明」（画在图里的灰白棋盘格）抠成真透明
# 用法：python tools/cutout.py <in.png> <out.png> [边长]
# 思路：只从画布边缘往里泛洪，所以被轮廓包住的白色（荷叶边、罐子）不会被误伤；
#       最后把 alpha 缩 1px 再柔化，去掉边缘那圈灰白光晕。
import sys
from collections import deque
from PIL import Image, ImageFilter

def cut(src, dst, size=512):
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    px = im.load()

    def is_bg(p):
        r, g, b, _ = p
        mx, mn = max(r, g, b), min(r, g, b)
        return mx - mn <= 10 and mx >= 222   # 近灰且够亮 = 棋盘格

    mask = bytearray(w * h)
    dq = deque()

    def seed(x, y):
        i = y * w + x
        if not mask[i] and is_bg(px[x, y]):
            mask[i] = 1
            dq.append(i)

    for x in range(w):
        seed(x, 0)
        seed(x, h - 1)
    for y in range(h):
        seed(0, y)
        seed(w - 1, y)

    while dq:
        i = dq.popleft()
        y, x = divmod(i, w)
        if x > 0:
            j = i - 1
            if not mask[j] and is_bg(px[x - 1, y]):
                mask[j] = 1; dq.append(j)
        if x < w - 1:
            j = i + 1
            if not mask[j] and is_bg(px[x + 1, y]):
                mask[j] = 1; dq.append(j)
        if y > 0:
            j = i - w
            if not mask[j] and is_bg(px[x, y - 1]):
                mask[j] = 1; dq.append(j)
        if y < h - 1:
            j = i + w
            if not mask[j] and is_bg(px[x, y + 1]):
                mask[j] = 1; dq.append(j)

    # alpha 通道：背景 0，其余 255
    alpha = Image.new('L', (w, h), 255)
    ap = alpha.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if mask[row + x]:
                ap[x, y] = 0

    # 收 1px + 轻微柔化：去掉边缘那圈灰白
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.6))

    rgb = im.convert('RGB')
    out = Image.merge('RGBA', (*rgb.split(), alpha))
    box = out.getbbox()
    if box:
        pad = 6
        box = (max(0, box[0] - pad), max(0, box[1] - pad),
               min(w, box[2] + pad), min(h, box[3] + pad))
        out = out.crop(box)
    # 按最长边缩放到 size（留 4% 余量）
    cw, ch = out.size
    scale = (size * 0.96) / max(cw, ch)
    out = out.resize((max(1, round(cw * scale)), max(1, round(ch * scale))), Image.LANCZOS)
    # 放进正方形画布，底部对齐
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(out, ((size - out.width) // 2, size - out.height), out)
    canvas.save(dst)
    print(f'{src} -> {dst}  crop={tuple(box)}  canvas={canvas.size}')

if __name__ == '__main__':
    cut(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 512)
