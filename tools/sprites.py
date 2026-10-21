# tools/sprites.py —— 从设定表里切出走路帧
# 设定表第三张：上排四个姿势，第 2、3 个是侧身迈步的两帧，来回切就是走路。
# 跑法：python tools/sprites.py
from PIL import Image
from cutout import cut_image, trim, to_canvas, largest_component

SHEET = 'art-source/maid-sheet.png'
# 上排第 2、3 个人物（原图 1254×1254，坐标按网格量出来的）
FRAMES = {
    'walk-a': (355, 92, 712, 665),
    'walk-b': (705, 92, 1060, 665),
}

def main():
    sheet = Image.open(SHEET)
    out = {}
    for name, box in FRAMES.items():
        piece = sheet.crop(box)
        cut = trim(largest_component(cut_image(piece)))
        out[name] = cut
        print(name, 'trimmed', cut.size)
    # 按高度各自归一：设定表里这几个人物本来就没有完全等高，
    # 用同一个缩放会让第二帧看起来矮一截（切换时像在跳）。
    size = 256
    for name, im in out.items():
        scale = (size * 0.94) / im.height
        rs = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
        canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        canvas.paste(rs, ((size - rs.width) // 2, size - rs.height), rs)
        canvas.save(f'assets/{name}.png')
        print('saved', f'assets/{name}.png', canvas.size)

if __name__ == '__main__':
    main()
