# tools/sprites.py —— 从设定表切走路帧（v2：整张一次抠，再按连通块找人）
#
# v1 的错：先按手量的框裁，再抠 —— 框切到人物，后面（背包、头发）就被切掉了，
#          脚边还会残留没被泛洪到的棋盘格。
# v2：整张图先抠干净，再对 alpha 做连通块，按面积和位置认出人物，各自取包围盒。
#
# 跑法：python tools/sprites.py
from PIL import Image
from cutout import cut_image, largest_component

SHEET = 'art-source/maid-sheet.png'
OUT = 'assets'
SIZE = 256
MIN_AREA = 6000      # 小于这个面积的块当装饰（箭头、星星、音符）丢掉


def components(im, thresh=10):
    """返回 alpha 的连通块列表：[{area, box:(l,t,r,b)}]，按面积从大到小"""
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


def strip_checker_blocks(im, min_area=400, min_fill=0.6):
    """清掉被人物围住的棋盘格。

    泛洪只能从画布边缘往里走，脚和腿围出来的那块进不去，于是留个白方块。
    棋盘格的特征是**两种中性灰白交替 + 整块是规规矩矩的矩形**，
    真·画面里的白（荷叶边、高光、地面阴影）边缘不规则，填不满包围盒。
    所以：找出所有"棋盘色"像素的连通块，面积够大且包围盒填充率高的，判为背景。
    """
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()

    def is_checker(p):
        r, g, b, _ = p
        if max(r, g, b) - min(r, g, b) > 4:
            return False
        return 236 <= r <= 243 or 251 <= r <= 255

    seen = bytearray(w * h)
    out = im.copy()
    op = out.load()
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if seen[i] or not is_checker(px[x, y]):
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
                        if not seen[k] and is_checker(px[nx, ny]):
                            seen[k] = 1
                            stack.append(k)
            if len(comp) < min_area:
                continue
            xs = [j % w for j in comp]
            ys = [j // w for j in comp]
            bw = max(xs) - min(xs) + 1
            bh = max(ys) - min(ys) + 1
            if len(comp) / float(bw * bh) < min_fill:
                continue
            for j in comp:
                jy, jx = divmod(j, w)
                op[jx, jy] = (0, 0, 0, 0)
    return out


def drop_ground_shadow(im, bottom_ratio=0.86, min_area=300):
    """去掉脚底那条地面阴影。

    它被画在棋盘格上：抠掉格子会剩一圈白边，空洞还会露出来。
    形状上它是「贴着图片最底部的一大片浅色、低饱和像素」，而且通常**和人物不相连**
    —— 所以按连通块找：浅色、够大、包围盒底部落在画面最下面那条带子里，整块删掉。
    深色鞋底、浅色但连在人物身上的衣服都不会被动到。
    """
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()

    def light(p):
        r, g, b, a = p
        if a == 0:
            return False
        mx, mn = max(r, g, b), min(r, g, b)
        return mx >= 190 and (mx - mn) <= 34

    seen = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if seen[i] or not light(px[x, y]):
                continue
            stack = [i]
            seen[i] = 1
            comp = []
            ys = []
            while stack:
                j = stack.pop()
                comp.append(j)
                jy, jx = divmod(j, w)
                ys.append(jy)
                for nx, ny in ((jx - 1, jy), (jx + 1, jy), (jx, jy - 1), (jx, jy + 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        k = ny * w + nx
                        if not seen[k] and light(px[nx, ny]):
                            seen[k] = 1
                            stack.append(k)
            if len(comp) < min_area:
                continue
            if max(ys) < h * bottom_ratio:
                continue          # 不贴地，是衣服/高光，留着
            for j in comp:
                jy, jx = divmod(j, w)
                px[jx, jy] = (0, 0, 0, 0)
    return im


def erode_light_fringe(im, rounds=4, min_bright=180, max_sat=46):
    """从透明区往里"啃"掉浅色边缘。

    棋盘格被清掉后，阴影和抗锯齿会在边界留下一圈浅色碎屑（面积太小，
    单看每个碎块都达不到"整块删除"的阈值）。这里换个思路：只删**和透明区相邻**的
    浅色像素，一轮 1px，跑几轮。衣服内部不和透明区相邻，不会被啃穿。
    """
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()
    for _ in range(rounds):
        todo = []
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a == 0:
                    continue
                mx, mn = max(r, g, b), min(r, g, b)
                if mx < min_bright or (mx - mn) > max_sat:
                    continue
                edge = False
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 0:
                        edge = True
                        break
                if edge:
                    todo.append((x, y))
        if not todo:
            break
        for x, y in todo:
            px[x, y] = (0, 0, 0, 0)
    return im


def trim_bottom_band(im, max_rows_ratio=0.10):
    """从底部往上砍掉"地面阴影带"。

    判定：某一行的不透明像素里，浅色低饱和的占多数 ⇒ 这行主要是阴影/碎屑，
    整行砍掉；遇到深色（鞋底）就停。最多砍掉高度的 10%，防止砍到鞋。
    """
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()
    limit = int(h * max_rows_ratio)
    cut_rows = 0
    for y in range(h - 1, max(0, h - 1 - limit), -1):
        solid = 0
        light = 0
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 40:
                continue
            solid += 1
            mx, mn = max(r, g, b), min(r, g, b)
            if mx >= 180 and (mx - mn) <= 48:
                light += 1
        if solid == 0 or light / solid >= 0.55:
            cut_rows += 1
            continue
        break
    if cut_rows:
        im = im.crop((0, 0, w, h - cut_rows))
    return im


def defringe(im, min_alpha=170):
    """最后一步：去掉半透明的浅色碎屑。

    阴影和棋盘格交界处会留一圈"半透明白"，放大看就是毛边。
    把「浅色 + 半透明」的像素直接清成透明，剩下的边缘由深色描边兜住。
    """
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0 or a >= min_alpha:
                continue
            mx, mn = max(r, g, b), min(r, g, b)
            if mx >= 170 and (mx - mn) <= 60:
                px[x, y] = (0, 0, 0, 0)
    return im


def main():
    sheet = Image.open(SHEET)
    cut = cut_image(sheet)          # 整张一次抠：只从画布边缘泛洪
    cut = strip_checker_blocks(cut) # 再清掉被人物围住的那几块
    cut = drop_ground_shadow(cut)    # 去掉脚底那条阴影
    cut = erode_light_fringe(cut)     # 再啃掉边缘的浅色碎屑
    w, h = cut.size

    comps = [c for c in components(cut) if c['area'] >= MIN_AREA]
    # 上排四个走路姿势：顶部在上半张、且够高
    top = [c for c in comps if c['box'][1] < h * 0.55 and (c['box'][3] - c['box'][1]) > h * 0.25]
    top.sort(key=lambda c: c['box'][0])
    print('上排识别到', len(top), '个：', [c['box'] for c in top])
    if len(top) < 3:
        raise SystemExit('没认全上排的人物，检查 MIN_AREA / 阈值')

    frames = {'walk-a': top[1], 'walk-b': top[2]}

    pieces = {}
    for name, c in frames.items():
        l, t, r, b = c['box']
        pad = 4
        piece = cut.crop((max(0, l - pad), max(0, t - pad), min(w, r + pad), min(h, b + pad)))
        # 块里可能混进贴着人物的小装饰，再取一次最大连通块更保险
        piece = largest_component(piece)
        piece = trim_bottom_band(piece)
        piece = defringe(piece)
        box = piece.getbbox()
        if box:
            piece = piece.crop(box)
        pieces[name] = piece
        print(name, 'box', c['box'], '->', piece.size)

    # 两帧按高度各自归一，脚踩同一条线
    for name, piece in pieces.items():
        scale = (SIZE * 0.94) / piece.height
        rs = piece.resize((max(1, round(piece.width * scale)), max(1, round(piece.height * scale))), Image.LANCZOS)
        canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
        canvas.paste(rs, ((SIZE - rs.width) // 2, SIZE - rs.height), rs)
        canvas.save(f'{OUT}/{name}.png')
        print('saved', f'{OUT}/{name}.png')


if __name__ == '__main__':
    main()
