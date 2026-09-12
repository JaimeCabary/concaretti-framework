import os
from pathlib import Path

root = Path(r"c:\Users\Admin\Desktop\The Council\New Concaretti")
ico = root / "icon.ico"
target = root / "START_CONCARETTI.bat"
desktop = Path(r"c:\Users\Admin\Desktop\Concaretti.lnk")

vbs_content = f'''Set oWS = WScript.CreateObject("WScript.Shell")
Set oLink = oWS.CreateShortcut("{desktop}")
oLink.TargetPath = "{target}"
oLink.WorkingDirectory = "{root}"
oLink.IconLocation = "{ico},0"
oLink.Description = "Concaretti Multi-Agent OS"
oLink.Save
'''

vbs_file = root / "make_lnk.vbs"
vbs_file.write_text(vbs_content, encoding="utf-8")
res = os.system(f'cscript //nologo "{vbs_file}"')
if vbs_file.exists():
    vbs_file.unlink()

if desktop.exists():
    print(f"[+] Desktop shortcut created successfully at: {desktop}")
else:
    print(f"[-] Failed to create shortcut. Exit code: {res}")
