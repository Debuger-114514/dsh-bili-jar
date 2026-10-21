# tools/cutout.py —— 把「假透明」（画在图里的灰白棋盘格）抠成真透明
# 用法：python tools/cutout.py <in.png> <out.png> [边长]
# 思路：只从画布边缘往里泛洪，所以被轮廓包住的白色（荷叶边、罐子、白肚皮）不会被误伤；
#       最后把 alpha 收 1px 再柔化，去掉边缘那圈灰白光晕。
import sys
from collections import deque
from PIL import Image, ImageFilter


def cut_image(im):
    """输入图片，返回抠掉棋盘格之后的 RGBA（尺寸不变）。"""
    im = im.convert('RGBA')
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

    alpha = Image.new('L', (w, h), 255)
    ap = alpha.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if mask[row + x]:
                ap[x, y] = 0

    # 收 1px + 柔化：去掉边缘那圈灰白
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.6))
    rgb = im.convert('RGB')
    return Image.merge('RGBA', (*rgb.split(), alpha))


def largest_component(im, thresh=10):
    """只留透明度连通块里最大的那一块（去隔壁人物的边角、箭头、星星）。"""
    im = im.convert('RGBA')
    w, h = im.size
    a = im.getchannel('A').load()
    seen = bytearray(w * h)
    best = []
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if seen[i] or a[x, y] <= thresh:
                continue
            stack = [i]
            seen[i] = 1
            comp = []
            while stack:
                j = stack.pop()
                comp.append(j)
                jy, jx = divmod(j, w)
                for nx, ny in ((jx - 1, jy), (jx + 1, jy), (jx, jy - 1), (jx, jy + 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        k = ny * w + nx
                        if not seen[k] and a[nx, ny] > thresh:
                            seen[k] = 1
                            stack.append(k)
            if len(comp) > len(best):
                best = comp
    keep = bytearray(w * h)
    for j in best:
        keep[j] = 1
    alpha = Image.new('L', (w, h), 0)
    ap = alpha.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if keep[row + x]:
                ap[x, y] = a[x, y]
    rgb = im.convert('RGB')
    return Image.merge('RGBA', (*rgb.split(), alpha))


def trim(im, pad=6):
    box = im.getbbox()
    if not box:
        return im
    w, h = im.size
    box = (max(0, box[0] - pad), max(0, box[1] - pad),
           min(w, box[2] + pad), min(h, box[3] + pad))
    return im.crop(box)


def to_canvas(im, size, bottom=True):
    """缩放进 size×size 的画布；底部对齐（走路帧要踩在同一条线上）。"""
    cw, ch = im.size
    scale = (size * 0.96) / max(cw, ch)
    im = im.resize((max(1, round(cw * scale)), max(1, round(ch * scale))), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    x = (size - im.width) // 2
    y = size - im.height if bottom else (size - im.height) // 2
    canvas.paste(im, (x, y), im)
    return canvas


def cut(src, dst, size=512):
    im = trim(cut_image(Image.open(src)))
    canvas = to_canvas(im, size)
    canvas.save(dst)
    print(f'{src} -> {dst}  src={im.size}  canvas={canvas.size}')


if __name__ == '__main__':
    cut(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 512)
