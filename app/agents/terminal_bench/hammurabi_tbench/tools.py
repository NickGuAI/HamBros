"""Tool definitions for the Hammurabi terminal-bench agent."""

TOOLS = [
    {
        "name": "bash_command",
        "description": (
            "Execute a bash command in the terminal. The command is sent as "
            "keystrokes to a tmux session inside a Docker container. Most "
            "commands should be single-line. For long-running commands, increase "
            "the timeout. The output is captured from the terminal screen."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash command to execute.",
                },
                "timeout": {
                    "type": "integer",
                    "description": (
                        "Max seconds to wait for command output. Use 5 for "
                        "simple commands (ls, cd, cat), 30 for moderate (pip "
                        "install, make), 180 for long-running (compilation, "
                        "training). Default: 30."
                    ),
                    "default": 30,
                },
            },
            "required": ["command"],
        },
    },
    {
        "name": "task_complete",
        "description": (
            "Signal that the task is complete. Call this ONLY when you are "
            "confident the task has been fully solved. You will be asked to "
            "confirm before the task is actually marked complete."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "explanation": {
                    "type": "string",
                    "description": "Brief explanation of what was done to solve the task.",
                },
            },
            "required": ["explanation"],
        },
    },
]

SYSTEM_PROMPT = """\
You are Hammurabi, an expert AI agent solving terminal tasks inside a Linux \
Docker container. You interact with the terminal by executing bash commands \
and reading their output.

Rules:
- Execute one command at a time and observe the output before deciding next steps.
- For file exploration, start with ls, pwd, cat to understand the environment.
- Read task instructions carefully. Pay attention to exact requirements.
- When installing packages, use appropriate package managers (apt, pip, npm, etc.).
- If a command produces no output, it likely succeeded silently.
- For long-running commands, set an appropriate timeout.
- When the task is complete, call task_complete with an explanation.
- Do NOT call task_complete prematurely. Verify your solution works first.
- If you encounter errors, debug systematically.
- Terminal output may be truncated. If needed, redirect output to a file and read it.
"""
