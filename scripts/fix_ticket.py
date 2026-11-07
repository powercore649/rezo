import re

path = r'c:\Users\raphw\Downloads\bumpify__1_\src\commands\moderation\ticket.js'

with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# ── Fix 1: corrupted handlePanelAdd return ──────────────────────────
# Pattern: the bad join line + any number of ')]})] }); lines after it
pattern = r"  \]\.join\(String\.fromCharCode\(10\)\)\}]\]}\) \}\);(\n'\)\]}\)\] \}\);)+"
replacement = "  ].join('\\n'))] });"
fixed, n = re.subn(pattern, replacement, content)
print(f'Fix1: {n} replacement(s)')

# ── Fix 2: handleOpenSelect missing closing ) before ; ───────────────
old2 = "ephemeral: true };\n    return engine.showOpenModal"
new2 = "ephemeral: true });\n    return engine.showOpenModal"
if old2 in fixed:
    fixed = fixed.replace(old2, new2)
    print('Fix2: applied')
else:
    # fallback: find the exact spot
    idx = fixed.find("ephemeral: true };")
    if idx != -1:
        ctx = fixed[idx-60:idx+40]
        print('Fix2 fallback context:', repr(ctx))
        fixed = fixed[:idx] + "ephemeral: true });" + fixed[idx+len("ephemeral: true };"):]
        print('Fix2: applied via fallback')
    else:
        print('Fix2: pattern not found')

with open(path, 'w', encoding='utf-8') as f:
    f.write(fixed)
print('File saved.')

# Quick verification
with open(path, 'r', encoding='utf-8') as f:
    verify = f.read()
print('Still has String.fromCharCode:', 'String.fromCharCode' in verify)
print('Has join newline fix:', "].join('\\n')" in verify)
# Count remaining ephemeral: true };  (should be 0 if fixed)
bad = verify.count("ephemeral: true };")
print(f'Remaining broken ephemeral lines: {bad}')
