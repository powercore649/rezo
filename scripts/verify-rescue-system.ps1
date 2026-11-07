# scripts/verify-rescue-system.ps1
# Script de vérification du système de récupération REZO

Write-Host "`n" -NoNewline
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "   VÉRIFICATION DU SYSTÈME DE RÉCUPÉRATION REZO" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

$totalChecks = 0
$passedChecks = 0
$failedChecks = 0

function Check-File {
    param (
        [string]$Path,
        [string]$Description
    )
    
    $script:totalChecks++
    
    if (Test-Path $Path) {
        Write-Host "[✓]" -ForegroundColor Green -NoNewline
        Write-Host " $Description"
        $script:passedChecks++
        return $true
    } else {
        Write-Host "[✗]" -ForegroundColor Red -NoNewline
        Write-Host " $Description" -ForegroundColor Red
        Write-Host "    Fichier manquant: $Path" -ForegroundColor Yellow
        $script:failedChecks++
        return $false
    }
}

function Check-Dependency {
    param (
        [string]$Package,
        [string]$Description
    )
    
    $script:totalChecks++
    
    $packageJsonPath = "package.json"
    
    if (Test-Path $packageJsonPath) {
        $packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
        
        if ($packageJson.dependencies.PSObject.Properties.Name -contains $Package) {
            Write-Host "[✓]" -ForegroundColor Green -NoNewline
            Write-Host " $Description"
            $script:passedChecks++
            return $true
        }
    }
    
    Write-Host "[✗]" -ForegroundColor Red -NoNewline
    Write-Host " $Description" -ForegroundColor Red
    Write-Host "    Dépendance manquante: $Package" -ForegroundColor Yellow
    $script:failedChecks++
    return $false
}

# ═══════════════════════════════════════════════════════════════════
# SECTION 1 : MODÈLES
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n1️⃣  MODÈLES" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor DarkGray

Check-File "src\models\ServerRescue.js" "Modèle ServerRescue"
Check-File "src\models\Server.js" "Modèle Server (modifié)"

# ═══════════════════════════════════════════════════════════════════
# SECTION 2 : COMMANDES
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n2️⃣  COMMANDES" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor DarkGray

Check-File "src\commands\configuration\setuprescue.js" "Commande /setuprescue"
Check-File "src\commands\configuration\claimserver.js" "Commande /claimserver"
Check-File "src\commands\configuration\extraowners.js" "Commande /extraowners"

# ═══════════════════════════════════════════════════════════════════
# SECTION 3 : UTILITAIRES
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n3️⃣  UTILITAIRES" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor DarkGray

Check-File "src\utils\extraOwnerCheck.js" "Utilitaire Extra Owner"

# ═══════════════════════════════════════════════════════════════════
# SECTION 4 : DOCUMENTATION
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n4️⃣  DOCUMENTATION" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor DarkGray

Check-File "RESCUE_SYSTEM_README.md" "Documentation technique"
Check-File "GUIDE_UTILISATEUR_RESCUE.md" "Guide utilisateur"
Check-File "CHANGELOG_RESCUE.md" "Changelog"
Check-File "INSTALLATION_RAPIDE_RESCUE.md" "Guide installation rapide"
Check-File "RESUME_IMPLEMENTATION.md" "Résumé d'implémentation"

# ═══════════════════════════════════════════════════════════════════
# SECTION 5 : TESTS
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n5️⃣  TESTS" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor DarkGray

Check-File "tests\rescue-system-test.js" "Tests automatisés"

# ═══════════════════════════════════════════════════════════════════
# SECTION 6 : DÉPENDANCES
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n6️⃣  DÉPENDANCES" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor DarkGray

Check-Dependency "otplib" "Package otplib (TOTP)"
Check-Dependency "qrcode" "Package qrcode (QR Codes)"

# ═══════════════════════════════════════════════════════════════════
# SECTION 7 : VÉRIFICATION DE node_modules
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n7️⃣  INSTALLATION" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor DarkGray

$totalChecks++
if (Test-Path "node_modules\otplib") {
    Write-Host "[✓]" -ForegroundColor Green -NoNewline
    Write-Host " Package otplib installé"
    $passedChecks++
} else {
    Write-Host "[✗]" -ForegroundColor Red -NoNewline
    Write-Host " Package otplib non installé" -ForegroundColor Red
    Write-Host "    Exécutez: npm install" -ForegroundColor Yellow
    $failedChecks++
}

$totalChecks++
if (Test-Path "node_modules\qrcode") {
    Write-Host "[✓]" -ForegroundColor Green -NoNewline
    Write-Host " Package qrcode installé"
    $passedChecks++
} else {
    Write-Host "[✗]" -ForegroundColor Red -NoNewline
    Write-Host " Package qrcode non installé" -ForegroundColor Red
    Write-Host "    Exécutez: npm install" -ForegroundColor Yellow
    $failedChecks++
}

# ═══════════════════════════════════════════════════════════════════
# RÉSULTATS
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n" -NoNewline
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "   RÉSULTATS" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

$percentage = [math]::Round(($passedChecks / $totalChecks) * 100, 0)

Write-Host "Total de vérifications : " -NoNewline
Write-Host "$totalChecks" -ForegroundColor White

Write-Host "Réussies               : " -NoNewline
Write-Host "$passedChecks" -ForegroundColor Green

if ($failedChecks -gt 0) {
    Write-Host "Échouées               : " -NoNewline
    Write-Host "$failedChecks" -ForegroundColor Red
}

Write-Host "Pourcentage            : " -NoNewline
if ($percentage -eq 100) {
    Write-Host "$percentage%" -ForegroundColor Green
} elseif ($percentage -ge 80) {
    Write-Host "$percentage%" -ForegroundColor Yellow
} else {
    Write-Host "$percentage%" -ForegroundColor Red
}

Write-Host ""

# ═══════════════════════════════════════════════════════════════════
# CONCLUSION
# ═══════════════════════════════════════════════════════════════════

if ($failedChecks -eq 0) {
    Write-Host "✅ " -NoNewline -ForegroundColor Green
    Write-Host "Système de récupération REZO installé avec succès !" -ForegroundColor Green
    Write-Host ""
    Write-Host "🚀 Prochaines étapes :" -ForegroundColor Cyan
    Write-Host "   1. Démarrer le bot : " -NoNewline
    Write-Host "npm start" -ForegroundColor White
    Write-Host "   2. Sur Discord     : " -NoNewline
    Write-Host "/setuprescue" -ForegroundColor White
    Write-Host "   3. Documentation   : " -NoNewline
    Write-Host "INSTALLATION_RAPIDE_RESCUE.md" -ForegroundColor White
    Write-Host ""
    
    # Proposer de lancer les tests
    Write-Host "💡 Lancer les tests automatisés ? (O/N) : " -NoNewline -ForegroundColor Yellow
    $response = Read-Host
    
    if ($response -eq "O" -or $response -eq "o") {
        Write-Host ""
        Write-Host "🧪 Exécution des tests..." -ForegroundColor Cyan
        Write-Host ""
        node tests\rescue-system-test.js
    }
    
} else {
    Write-Host "❌ " -NoNewline -ForegroundColor Red
    Write-Host "Installation incomplète ($failedChecks erreur(s))" -ForegroundColor Red
    Write-Host ""
    Write-Host "🔧 Actions recommandées :" -ForegroundColor Yellow
    
    if (-not (Test-Path "node_modules\otplib") -or -not (Test-Path "node_modules\qrcode")) {
        Write-Host "   • Installer les dépendances : " -NoNewline
        Write-Host "npm install" -ForegroundColor White
    }
    
    Write-Host "   • Vérifier les fichiers manquants ci-dessus"
    Write-Host "   • Consulter : " -NoNewline
    Write-Host "RESUME_IMPLEMENTATION.md" -ForegroundColor White
    Write-Host ""
}

Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Code de sortie
if ($failedChecks -eq 0) {
    exit 0
} else {
    exit 1
}
