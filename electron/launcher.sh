#!/bin/sh
# Open作业贴 · 启动包装器
#
# 唯一目的：启动前检查 Electron 需要的系统库在不在，
# 缺的话给出**看得懂的中文提示**，而不是丢一行英文报错。
#
# 【重要】这里不做任何 LD_LIBRARY_PATH 注入。
# 早先版本曾把自带的 libgbm.so.1 放进 LD_LIBRARY_PATH 前缀，
# 结果那份库是从 Ubuntu 22.04 取的、要求 GLIBC_2.34，
# 而 UOS 20 只有 glibc 2.28 —— 系统本来能用的库被抢走后加载失败，
# 反而不如不包装。教训：不要用版本不兼容的二进制去"兜底"。

APP_DIR="$(dirname "$(readlink -f "$0")")"
APP="$APP_DIR/open-yitie"

if [ ! -x "$APP" ]; then
    echo ""
    echo "  Open作业贴：找不到主程序 $APP"
    echo "  安装可能不完整，请重新安装。"
    echo ""
    exit 1
fi

# 检查关键动态库（Electron 启动前就要加载的）
MISSING=""
for lib in libgbm.so.1 libnss3.so libatk-1.0.so.0 libgtk-3.so.0; do
    if ! (command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q "$lib"); then
        MISSING="$MISSING $lib"
    fi
done

if [ -n "$MISSING" ]; then
    echo ""
    echo "  Open作业贴：系统缺少运行所需的图形库"
    echo "  缺失：$MISSING"
    echo ""
    echo "  这是精简版 / 服务器版系统常见的情况（没有桌面环境）。"
    echo "  在桌面版 UOS 上通常不会有这个问题。"
    echo ""
    echo "  修复方法（任选其一）："
    echo "    sudo apt install -f          # 自动补齐依赖"
    echo "    sudo apt install libgbm1     # 只装缺的那个"
    echo ""
    exit 1
fi

# 无 setuid 场景下 Chromium 沙箱不可用，自动加 --no-sandbox
EXTRA=""
SANDBOX="$APP_DIR/chrome-sandbox"
if [ -f "$SANDBOX" ]; then
    if [ ! -u "$SANDBOX" ]; then
        EXTRA="--no-sandbox"
    fi
else
    EXTRA="--no-sandbox"
fi

exec "$APP" $EXTRA "$@"
