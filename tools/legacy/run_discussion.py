import os
import subprocess
import sys
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
os.environ["PYTHONUNBUFFERED"] = "1"

workspace_root = Path(__file__).resolve().parents[2]
sys.exit(
	subprocess.call(
		[
			r"C:\Users\leomx\AppData\Local\Programs\Python\Python312\python.exe",
			"-u",
			str(workspace_root / "ansteel_agents.py"),
			"审查 USER/Src/control_loop.c 中 MPC 与 PID 的切换逻辑。重点：1) bumpless transfer 是否正确 2) 切换条件是否安全 3) 输出跳变风险 4) 故障回退时积分项重置。读取源码后给出结论。",
			"--workdir",
			r"F:\温控",
			"--mode",
			"B",
		]
	)
)
