#!/usr/bin/env python3
"""构建飞牛 fnOS 应用包（fpk）。

流程：
  1. 用 esbuild 把 src-fnos/index.js 及其依赖打成单文件 fnos-fpk/app/src/bundle.cjs
     （NAS 上不安装 node_modules，bundle 自带 puppeteer-core 等依赖）
  2. 在 fnos-fpk/ 目录调用 fnpack build 生成 fpk

依赖：Node 22+、npm（esbuild 由 devDependencies 提供）、fnpack（需在 PATH 中）
用法：python fnos-fpk/build-fpk.py
"""
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MANIFEST = os.path.join(HERE, "manifest")
BUNDLE = os.path.join(HERE, "app", "src", "bundle.cjs")


def read_version():
    with open(MANIFEST, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"\s*version\s*=\s*(\S+)", line)
            if m:
                return m.group(1)
    raise SystemExit("manifest 中没有找到 version 字段")


def run(cmd, cwd):
    print("+", " ".join(cmd))
    p = subprocess.run(cmd, cwd=cwd, shell=(os.name == "nt"))
    if p.returncode != 0:
        raise SystemExit(f"命令失败（{p.returncode}）：{cmd}")


def main():
    version = read_version()
    os.makedirs(os.path.dirname(BUNDLE), exist_ok=True)

    esbuild = os.path.join(ROOT, "node_modules", ".bin",
                           "esbuild.cmd" if os.name == "nt" else "esbuild")
    if not os.path.exists(esbuild):
        raise SystemExit("找不到 esbuild，请先在仓库根目录执行 npm install")

    run([esbuild, os.path.join("src-fnos", "index.js"),
         "--bundle", "--platform=node", "--target=node20", "--format=cjs",
         "--outfile=" + os.path.join("fnos-fpk", "app", "src", "bundle.cjs")], ROOT)
    print("bundle:", os.path.getsize(BUNDLE), "bytes")

    if shutil.which("fnpack") is None:
        raise SystemExit("找不到 fnpack，请先安装 fnpack 并加入 PATH（或在 NAS 上打包）")

    run(["fnpack", "build"], HERE)

    for name in sorted(os.listdir(HERE)):
        if name.endswith(".fpk"):
            path = os.path.join(HERE, name)
            print(f"fpk: {path}  ({os.path.getsize(path)} bytes)")
    print("manifest version:", version)


if __name__ == "__main__":
    main()
