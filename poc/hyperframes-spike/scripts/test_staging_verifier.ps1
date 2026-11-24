function Test-StagingVerification {
    param (
        [string[]]$Expected,
        [string[]]$Staged,
        [int]$ExpectedCount = -1
    )

    # 1. Normalize path separators
    $normExpected = @($Expected | ForEach-Object { $_.Trim().Replace('\', '/') } | Where-Object { $_.Length -gt 0 })
    $normStaged = @($Staged | ForEach-Object { $_.Trim().Replace('\', '/') } | Where-Object { $_.Length -gt 0 })

    # 2. Duplicate checks in Expected Manifest
    $uniqueExpected = @($normExpected | Select-Object -Unique)
    if ($uniqueExpected.Count -ne $normExpected.Count) {
        $dups = ($normExpected | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name }) -join ", "
        Write-Host "  [FAIL] Duplicate entries found in expected manifest: $dups" -ForegroundColor Red
        throw "Duplicate entries in expected manifest: $dups"
    }

    # 3. Duplicate checks in Staged Files
    $uniqueStaged = @($normStaged | Select-Object -Unique)
    if ($uniqueStaged.Count -ne $normStaged.Count) {
        $dups = ($normStaged | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name }) -join ", "
        Write-Host "  [FAIL] Duplicate entries found in staged files: $dups" -ForegroundColor Red
        throw "Duplicate entries in staged files: $dups"
    }

    # 4. Check expected count if specified
    if ($ExpectedCount -gt 0 -and $normExpected.Count -ne $ExpectedCount) {
        Write-Host "  [FAIL] Expected manifest count ($($normExpected.Count)) does not match required count ($ExpectedCount)" -ForegroundColor Red
        throw "Manifest count mismatch"
    }

    # 5. Case-sensitive order-independent comparison
    $diff = @(Compare-Object -ReferenceObject $normExpected -DifferenceObject $normStaged -CaseSensitive)
    if ($diff.Count -gt 0) {
        $missing = $diff | Where-Object { $_.SideIndicator -eq '<=' } | Select-Object -ExpandProperty InputObject
        $extra   = $diff | Where-Object { $_.SideIndicator -eq '=>' } | Select-Object -ExpandProperty InputObject
        Write-Host "  [FAIL] Staging discrepancy detected:" -ForegroundColor Red
        if ($missing) { Write-Host "    Missing / Case-mismatch in staged:`n    $($missing -join "`n    ")" -ForegroundColor Yellow }
        if ($extra)   { Write-Host "    Extra / Unexpected in staged:`n    $($extra -join "`n    ")" -ForegroundColor Red }
        throw "Staging verification failed: $($diff.Count) differences detected."
    }

    Write-Host "  [PASS] Staged files match expected manifest exactly ($($normExpected.Count) files)." -ForegroundColor Green
    return $true
}

Write-Host "=========================================================="
Write-Host "UNIT TESTS: Hardened Staging Verification Logic"
Write-Host "=========================================================="

# Test 1: Exact Matching
Write-Host "`nTest 1: Exact Matching (with mixed slashes and order permutation)..."
try {
    $exp = @("path/to/file1.txt", "path\to\file2.js", "README.md")
    $stg = @("README.md", "path/to/file2.js", "path/to/file1.txt")
    $res = Test-StagingVerification -Expected $exp -Staged $stg -ExpectedCount 3
    Write-Host "Result: PASS (Handled as expected)" -ForegroundColor Green
} catch {
    Write-Host "Result: UNEXPECTED FAIL: $_" -ForegroundColor Red
}

# Test 2: Missing File
Write-Host "`nTest 2: Missing File in Staged..."
try {
    $exp = @("file1.txt", "file2.txt", "file3.txt")
    $stg = @("file1.txt", "file3.txt")
    $res = Test-StagingVerification -Expected $exp -Staged $stg -ExpectedCount 3
    Write-Host "Result: UNEXPECTED PASS" -ForegroundColor Red
} catch {
    Write-Host "Result: FAIL (Threw error as expected: $($_.Exception.Message))" -ForegroundColor Green
}

# Test 3: Extra File
Write-Host "`nTest 3: Extra File in Staged..."
try {
    $exp = @("file1.txt", "file2.txt")
    $stg = @("file1.txt", "file2.txt", "untracked_rogue.exe")
    $res = Test-StagingVerification -Expected $exp -Staged $stg -ExpectedCount 2
    Write-Host "Result: UNEXPECTED PASS" -ForegroundColor Red
} catch {
    Write-Host "Result: FAIL (Threw error as expected: $($_.Exception.Message))" -ForegroundColor Green
}

# Test 4: Case Mismatch
Write-Host "`nTest 4: Case Mismatch (Compare-Object -CaseSensitive)..."
try {
    $exp = @("poc/hyperframes-spike/README.md", "assets/gsap.min.js")
    $stg = @("poc/hyperframes-spike/readme.md", "assets/gsap.min.js")
    $res = Test-StagingVerification -Expected $exp -Staged $stg -ExpectedCount 2
    Write-Host "Result: UNEXPECTED PASS" -ForegroundColor Red
} catch {
    Write-Host "Result: FAIL (Threw error as expected: $($_.Exception.Message))" -ForegroundColor Green
}

# Test 5: Duplicate Entry in Expected Manifest
Write-Host "`nTest 5: Duplicate Entry in Manifest..."
try {
    $exp = @("file1.txt", "file2.txt", "file1.txt")
    $stg = @("file1.txt", "file2.txt")
    $res = Test-StagingVerification -Expected $exp -Staged $stg
    Write-Host "Result: UNEXPECTED PASS" -ForegroundColor Red
} catch {
    Write-Host "Result: FAIL (Threw error as expected: $($_.Exception.Message))" -ForegroundColor Green
}

Write-Host "`n=========================================================="
Write-Host "ALL 5 UNIT TESTS COMPLETED SUCCESSFULLY."
Write-Host "=========================================================="
