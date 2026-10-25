"""生成扩展图标：橙色圆角方块 + 白色播放三角。运行一次即可。"""
import os
from PIL import Image, ImageDraw

S = 512
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)

# 渐变底
grad = Image.new("RGB", (S, S))
d = ImageDraw.Draw(grad)
c1 = (255, 160, 46)   # #ffa02e
c2 = (255, 115, 0)    # #ff7300
for y in range(S):
    for_x = y / (S - 1)
    # 对角线渐变：x 权重也给一点
    pass
# 逐像素做 135° 线性渐变
px = grad.load()
for y in range(S):
    for x in range(S):
        t = (x / (S - 1) + y / (S - 1)) / 2
        px[x, y] = (
            int(c1[0] + (c2[0] - c1[0]) * t),
            int(c1[1] + (c2[1] - c1[1]) * t),
            int(c1[2] + (c2[2] - c1[2]) * t),
        )

# 圆角遮罩
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.24), fill=255)

icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(grad, (0, 0), mask)

# 播放三角
dr = ImageDraw.Draw(icon)
w = S * 0.30
h = S * 0.36
cx, cy = S * 0.525, S * 0.5
pts = [(cx - w / 2, cy - h / 2), (cx - w / 2, cy + h / 2), (cx + w / 2, cy)]
dr.polygon(pts, fill=(255, 255, 255, 255))

# 底部一条进度条，暗示"自动下一节"
bar_y = S * 0.76
dr.rounded_rectangle(
    [S * 0.24, bar_y, S * 0.76, bar_y + S * 0.055],
    radius=S * 0.028,
    fill=(255, 255, 255, 120),
)
dr.rounded_rectangle(
    [S * 0.24, bar_y, S * 0.55, bar_y + S * 0.055],
    radius=S * 0.028,
    fill=(255, 255, 255, 235),
)

for size in (16, 32, 48, 128):
    icon.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon{size}.png"))

print("icons ->", OUT, os.listdir(OUT))
