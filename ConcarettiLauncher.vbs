Set WshShell = CreateObject("WScript.Shell")
' Run the python script using uv invisibly (0 window style)
WshShell.Run "cmd.exe /c uv run --project backend python run_desktop.py", 0
Set WshShell = Nothing
