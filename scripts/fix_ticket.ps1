$path = "c:\Users\raphw\Downloads\bumpify__1_\src\commands\moderation\ticket.js"
$content = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)

# Fix 1: replace the corrupted join+repeated lines block
# The corrupted text is:  ].join(String.fromCharCode(10))}]})] });  followed by many  ')]})] });  lines
$pattern = "(?s)  \]\.join\(String\.fromCharCode\(10\)\)\}]\]}\) \}\);(\r?\n'\)\]}\)\] \}\);)+"
$replacement = "  ].join('\n'))] });"
$fixed = [regex]::Replace($content, $pattern, $replacement)

$c1 = ($content -match "String\.fromCharCode")
$c2 = ($fixed -match "String\.fromCharCode")
Write-Host "Had fromCharCode: $c1  Still has: $c2"

# Fix 2: missing closing ) in handleOpenSelect
$old2 = "ephemeral: true };"
$new2 = "ephemeral: true });"
# Count occurrences
$occurrences = ([regex]::Matches($fixed, [regex]::Escape($old2))).Count
Write-Host "Occurrences of 'ephemeral: true };': $occurrences"
if ($occurrences -gt 0) {
    $fixed = $fixed.Replace($old2, $new2)
    Write-Host "Fix2 applied"
}

[System.IO.File]::WriteAllText($path, $fixed, [System.Text.Encoding]::UTF8)
Write-Host "Done. File saved."
