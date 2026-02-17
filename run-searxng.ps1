# Run SearXNG with JSON format enabled. Run from project root or any folder.
$settingsPath = Join-Path $PSScriptRoot "searxng-settings.yml"
if (-not (Test-Path $settingsPath)) {
    Write-Error "Not found: $settingsPath"
    exit 1
}
# Docker on Windows: use path with forward slashes for the bind mount
$mountPath = $settingsPath -replace '\\', '/'
docker rm -f searxng 2>$null
docker run -d -p 8081:8080 -v "${mountPath}:/etc/searxng/settings.yml" --name searxng searxng/searxng
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker run failed. Is Docker running?"
    exit 1
}
Write-Host "Waiting for SearXNG to be ready (up to 60s)..."
$url = "http://127.0.0.1:8081"
$max = 30
for ($i = 0; $i -lt $max; $i++) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        Write-Host "SearXNG is ready. Run: node index.js discover --config config.json --out domains.json"
        exit 0
    } catch {}
    Start-Sleep -Seconds 2
}
Write-Host "SearXNG may still be starting. Check: docker ps (container searxng), docker logs searxng"
