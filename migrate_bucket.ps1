# limpeza_definitiva.ps1
$INFLUX_URL = "http://10.0.0.45:8086"
$INFLUX_TOKEN = "T6M0gntRz3BX-q_huEoxfe11-raaAG-DKd-Byz1uMioSHw8OPsoPdpH5eY5o7RtgwY_vrhMo56lOVsWm1fVQXA=="
$INFLUX_ORG = "RotaHotspot"
$BUCKET = "monitor"

Write-Host "=== LIMPEZA DEFINITIVA - ATENÇÃO ===" -ForegroundColor Red -BackgroundColor Black
Write-Host "ESTA AÇÃO VAI APAGAR TODOS OS DADOS DO BUCKET '$BUCKET'!" -ForegroundColor Red
Write-Host "NÃO SERÁ POSSÍVEL RECUPERAR OS DADOS!" -ForegroundColor Red
Write-Host ""
Write-Host "Deseja realmente continuar? (Digite 'SIM' para confirmar)" -ForegroundColor Yellow
$confirm = Read-Host

if ($confirm -ne "SIM") {
    Write-Host "Operação cancelada pelo usuário." -ForegroundColor Green
    exit 0
}

# URL para deletar TUDO
$url = "$INFLUX_URL/api/v2/delete?org=$([Uri]::EscapeDataString($INFLUX_ORG))&bucket=$([Uri]::EscapeDataString($BUCKET))"
$body = @{
    start = "1970-01-01T00:00:00Z"
    stop = (Get-Date).ToUniversalTime().ToString("o")
    predicate = ""  # Vazio = deleta TUDO
} | ConvertTo-Json

try {
    Write-Host "Iniciando limpeza total..." -ForegroundColor Yellow
    Write-Host "URL: $url" -ForegroundColor Gray
    
    $response = Invoke-RestMethod -Method Post -Uri $url -Headers @{
        Authorization = "Token $INFLUX_TOKEN"
        'Content-Type' = 'application/json'
    } -Body $body -ErrorAction Stop
    
    Write-Host "✅ BUCKET COMPLETAMENTE LIMPO!" -ForegroundColor Green
    
    # Verificar se o bucket está vazio
    Start-Sleep -Seconds 2
    
    # Tentar uma query para verificar
    $query = 'from(bucket: "monitor") |> range(start: -1m) |> count()'
    $queryBody = @{query = $query; type = "flux"} | ConvertTo-Json
    
    try {
        $queryResponse = Invoke-RestMethod -Method Post -Uri "$INFLUX_URL/api/v2/query?org=$([Uri]::EscapeDataString($INFLUX_ORG))" -Headers @{
            Authorization = "Token $INFLUX_TOKEN"
            'Content-Type' = 'application/json'
        } -Body $queryBody -ErrorAction SilentlyContinue
        
        if ($queryResponse -and $queryResponse -match ",_result") {
            Write-Host "⚠️  Ainda há dados no bucket após a limpeza." -ForegroundColor Yellow
        } else {
            Write-Host "✅ Bucket verificado: VAZIO" -ForegroundColor Green
        }
    } catch {
        Write-Host "✅ Bucket verificado: VAZIO (sem dados para retornar)" -ForegroundColor Green
    }
    
    Write-Host ""
    Write-Host "=== PROCEDIMENTO PÓS-LIMPEZA ===" -ForegroundColor Cyan
    Write-Host "1. PARE o servidor backend (Ctrl+C)" -ForegroundColor Yellow
    Write-Host "2. PARE o agente agent.js (Ctrl+C)" -ForegroundColor Yellow
    Write-Host "3. Aguarde 10 segundos" -ForegroundColor Yellow
    Write-Host "4. Reinicie o agente agent.js" -ForegroundColor Yellow
    Write-Host "5. Aguarde 1-2 minutos para coleta de dados" -ForegroundColor Yellow
    Write-Host "6. Reinicie o servidor backend" -ForegroundColor Yellow
    
} catch {
    Write-Host "❌ ERRO na limpeza: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Status Code: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
}