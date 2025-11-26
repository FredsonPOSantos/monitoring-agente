// Carrega as variáveis de ambiente do ficheiro .env
const dotenv = require('dotenv');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

// Ajuste da importação para suportar o pacote 'node-routeros' que expõe RouterOSAPI
let RouterOSClient;
try {
    const _mod = require('node-routeros'); // pacote declarado no package.json
    // tenta várias chaves possíveis de export
    RouterOSClient = _mod.RouterOSClient ?? _mod.RouterOSAPI ?? _mod.default ?? _mod;
    console.log('[AGENTE] Chaves do módulo node-routeros:', Object.keys(_mod));
} catch (err) {
    console.error('[AGENTE] Não foi possível carregar "node-routeros":', err.message);
    console.error('Tente executar: npm install node-routeros --save');
    process.exit(1);
}

if (typeof RouterOSClient !== 'function') {
    console.error('[AGENTE] RouterOSClient não é um construtor. Chaves do módulo:', Object.keys(require('node-routeros') || {}));
    process.exit(1);
}

// --- 1. Configuração Inicial ---
dotenv.config();
console.log(`[dotenv@${require('dotenv/package.json').version}] injecting env (${Object.keys(process.env).length}) from .env -- tip: 🛠️ run anywhere with dotenvx run -- yourcommand`);

const INFLUX_URL = process.env.INFLUXDB_URL;
const INFLUX_TOKEN = process.env.INFLUXDB_TOKEN;
const INFLUX_ORG = process.env.INFLUXDB_ORG;
const INFLUX_BUCKET = process.env.INFLUXDB_BUCKET;

const MIKROTIK_API_PORT = process.env.MIKROTIK_API_PORT || 8728;
const MIKROTIK_USER = process.env.MIKROTIK_USER;
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD;

// Validação das variáveis de ambiente essenciais
if (!INFLUX_URL || !INFLUX_TOKEN || !INFLUX_ORG || !INFLUX_BUCKET) {
    console.error("❌ Erro: Uma ou mais variáveis de ambiente do InfluxDB (INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET) não estão definidas no seu ficheiro .env.");
    console.error("Por favor, verifique o seu ficheiro .env e tente novamente.");
    process.exit(1); // Termina o script com um código de erro.
}

// Simulação da busca de roteadores no PostgreSQL (Fase 2.1)
// Em um cenário real, isso viria do seu banco de dados.
const getRoutersFromDB = async () => {
    // TODO: Implementar a lógica para buscar do PostgreSQL
    // Por enquanto, usamos uma lista estática para teste.
    // Correção: Usar a variável ROUTER_HOSTS e dividi-la por vírgula para suportar múltiplos hosts.
    return process.env.ROUTER_HOSTS ? process.env.ROUTER_HOSTS.split(',') : [];
};

// --- 2. Cliente InfluxDB ---
const influxDB = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
const writeApi = influxDB.getWriteApi(INFLUX_ORG, INFLUX_BUCKET);
console.log(`[INFLUXDB] Cliente configurado para o bucket: ${INFLUX_BUCKET} 🚀`);

// --- 3. Lógica de Coleta de Métricas ---

/**
 * Conecta-se a um roteador MikroTik e coleta métricas.
 * Compatibilidade: tenta usar métodos comuns (connect/open, write/menu, close/disconnect).
 */
const collectMetrics = async (host) => {
    console.log(`[API] A conectar-se a ${host}:${MIKROTIK_API_PORT}...`);

    const client = new RouterOSClient({
        host: host,
        port: MIKROTIK_API_PORT,
        username: MIKROTIK_USER,
        user: MIKROTIK_USER,
        password: MIKROTIK_PASSWORD,
        timeout: 5,
    });

    const doConnect = async () => {
        if (typeof client.connect === 'function') return client.connect();
        if (typeof client.open === 'function') return client.open();
        if (typeof client.connectSocket === 'function') return client.connectSocket();
        return Promise.resolve();
    };
    const doClose = async () => {
        if (typeof client.close === 'function') return client.close();
        if (typeof client.disconnect === 'function') return client.disconnect();
        if (typeof client.end === 'function') return client.end();
        return Promise.resolve();
    };

    // executor compatível: tenta client.write(...) ou client.menu(...).get()
    const runCommand = async (cmd, args = []) => {
        try {
            if (typeof client.write === 'function') {
                return await client.write(cmd, args);
            } else if (typeof client.menu === 'function') {
                // transforma "/system/resource/print" -> "/system/resource"
                const menuPath = '/' + cmd.replace(/^\/|\/print$/g, '').replace(/\/$/, '');
                return await client.menu(menuPath).get();
            } else {
                throw new Error('Nenhum método conhecido para executar comandos no cliente RouterOS.');
            }
        } catch (e) {
            throw e;
        }
    };

// NOVO: funções utilitárias e flattenAndWrite movidas para escopo global
const measurementForcedString = {
    'ip_firewall_filter': new Set(['dst_port','src_port','dst_address_list','src_address_list','ports','dst_port_list','src_port_list','protocol'])
};
// SOLUÇÃO PROBLEMA 1: Forçar campos que devem ser numéricos a serem tratados como tal.
const measurementForcedNumber = {
    'system_resource': new Set(['cpu_load', 'free_memory', 'total_memory', 'free_hdd_space', 'total_hdd_space', 'uptime', 'bad_blocks']),
    'system_health': new Set(['voltage', 'temperature']),
    // Unificado: contém campos de 'print' e 'monitor-traffic'
    'interface_stats': new Set(['mtu','rx_byte','tx_byte','rx-packet','tx-packet','rx-drop','tx-drop','rx-error','tx-error', 'rx_bits_per_second', 'tx_bits_per_second', 'rx_packets_per_second', 'tx_packets_per_second']),
    'interface_monitor': new Set(['rx_bits_per_second', 'tx_bits_per_second', 'rx_packets_per_second', 'tx_packets_per_second']),
    // NOVO: Métricas numéricas para clientes wireless
    'interface_wireless_registration_table': new Set(['signal_strength_dbm', 'tx_rate', 'rx_rate', 'tx_bytes', 'rx_bytes', 'tx_packets', 'rx_packets', 'uptime_seconds']),
    'ip_arp': new Set([]), 
    'ip_dhcp_server_lease': new Set([]), // Nenhum campo numérico óbvio para forçar
    'system_routerboard': new Set([]),
    // O campo 'time' em clock é uma string 'HH:mm:ss', não deve ser numérico.
    'system_clock': new Set([]), 
    'ip_address': new Set([]),
    'user': new Set([])
};
const sanitizeKey = (k) => String(k).replace(/[^a-zA-Z0-9_]/g,'_').replace(/^_+|_+$/g,'').toLowerCase();
const isNumericString = (s) => /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(String(s).trim());

/**
 * Converte a string de duração do MikroTik (ex: "1w2d3h4m5s") para segundos.
 * @param {string} durationString A string de duração.
 * @returns {number} O número total de segundos.
 */
const parseMikroTikUptime = (durationString) => {
    const match = durationString.match(/(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    if (!match) return 0;
    const weeks = parseInt(match[1] || '0', 10);
    const days = parseInt(match[2] || '0', 10);
    const hours = parseInt(match[3] || '0', 10);
    const minutes = parseInt(match[4] || '0', 10);
    const seconds = parseInt(match[5] || '0', 10);
    return (weeks * 604800) + (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
};

const flattenAndWrite = (measurement, item, extraTags = {}, host) => {
    const meas = String(measurement).toLowerCase();
    const p = new Point(meas).tag('router_host', host || 'unknown');

    for (const [k, v] of Object.entries(extraTags || {})) {
        p.tag(sanitizeKey(k), String(v));
    }

    for (const [k, v] of Object.entries(item || {})) {
        if (v === undefined || v === null) continue;
        const sk = sanitizeKey(k);
        const raw = (typeof v === 'object') ? JSON.stringify(v) : String(v).trim();

        // Tratamento especial para uptime (agora genérico para qualquer medição)
        if (sk === 'uptime') {
            p.intField('uptime_seconds', parseMikroTikUptime(raw));
            continue; // Pula para o próximo campo
        }

        // Tratamento especial para signal-strength (ex: "-55dBm@6Mbps")
        if (sk === 'signal_strength') {
            const strengthMatch = raw.match(/^(-?\d+)/);
            if (strengthMatch) {
                p.intField('signal_strength_dbm', parseInt(strengthMatch[1], 10));
            }
            continue;
        }

        // Tratamento especial para campos com "tx/rx" (ex: "12345/67890")
        if (sk === 'bytes' || sk === 'packets') {
            const parts = raw.split('/');
            if (parts.length === 2) {
                const tx = parseInt(parts[0], 10);
                const rx = parseInt(parts[1], 10);
                if (!isNaN(tx)) p.intField(`tx_${sk}`, tx);
                if (!isNaN(rx)) p.intField(`rx_${sk}`, rx);
            }
            continue; // Pula para o próximo campo
        }

        // Apenas processa campos que estão explicitamente definidos como numéricos
        if (measurementForcedNumber[meas] && measurementForcedNumber[meas].has(sk)) {
            if (isNumericString(raw)) {
                if (raw.indexOf('.') !== -1 || /[eE]/.test(raw)) p.floatField(sk, Number(raw));
                else p.intField(sk, parseInt(raw, 10));
            }
        }
        // O resto (campos de string) é ignorado para evitar conflitos, conforme solicitado.
    }

    try {
        writeApi.writePoint(p);
    } catch (e) {
        console.error(`[INFLUXDB] Erro ao escrever ponto ${measurement}:`, e.message);
    }
};

    try {
        await doConnect();
        console.log(`[API] Conectado com sucesso a ${host}. Coletando métricas...`);

        // --- Verificação de Capacidades (Capabilities) ---
        const packages = await runCommand('/system/package/print');
        const isWirelessEnabled = packages.some(pkg => pkg.name === 'wireless' && pkg.disabled === 'false');

        // --- Construção da Lista de Comandos Dinâmica ---
        const commands = [
            '/system/resource/print',      // Métricas vitais: CPU, memória, uptime
            '/system/health/print',        // Tensão e temperatura
            '/system/routerboard/print',   // Modelo, firmware, número de série
            '/system/clock/print',         // Data e hora do sistema
            '/ip/address/print',           // Endereços IP configurados
            '/ip/arp/print',               // Tabela ARP (IPs e MACs na rede)
            '/ip/dhcp-server/lease/print', // Clientes DHCP ativos
            '/user/print'                  // Utilizadores configurados no router
        ];

        if (isWirelessEnabled) {
            console.log(`[API] Pacote wireless detectado em ${host}. Coletando métricas de Wi-Fi.`);
            commands.push('/interface/wireless/registration-table/print');
        } else {
            console.log(`[API] Pacote wireless não detectado ou desativado em ${host}. Pulando métricas de Wi-Fi.`);
        }

        for (const cmd of commands) {
            try {
                const res = await runCommand(cmd);
                if (!res) continue;

                // normaliza para array
                const rows = Array.isArray(res) ? res : (res ? [res] : []);
                const baseMeasurement = cmd
                    .replace(/^\//, '')
                    .replace(/\/print$/, '')
                    .replace(/\//g, '_') || 'unknown';

                // escreve cada item como ponto separado
                rows.forEach(row => {
                    flattenAndWrite(baseMeasurement, row, {}, host); // SOLUÇÃO PROBLEMA 2: Passar o host
                });
            } catch (e) {
                console.warn(`[API] Falha ao executar comando "${cmd}" em ${host}: ${e.message}`);
            }
        }

        // --- Coleta Individual de Métricas de Interface ---
        try {
            console.log(`[API] Buscando lista de interfaces em ${host}...`);
            const intfRes = await runCommand('/interface/print');
            const interfaces = Array.isArray(intfRes) ? intfRes : (intfRes ? [intfRes] : []);
            
            console.log(`[API] Encontradas ${interfaces.length} interfaces. Coletando dados individualmente...`);
            for (const iface of interfaces) {
                const name = iface.name || iface['.id'];
                if (!name) continue;

                console.log(`[API] Coletando dados para a interface "${name}"...`);
                // Combina os dados estáticos (iface) com os dados de tráfego em tempo real
                // SOLUÇÃO: Passa os argumentos como um array para lidar com espaços nos nomes
                const trafficStats = await runCommand(
                    '/interface/monitor-traffic', 
                    [`=interface=${name}`, '=once=yes']
                );
                const combinedData = Object.assign({}, iface, trafficStats[0] || {});

                // Escreve um único ponto de dados com todas as informações da interface
                flattenAndWrite('interface_stats', combinedData, { interface_name: name }, host);
            }
        } catch (e) {
            console.warn(`[API] Falha ao coletar métricas de interface em ${host}: ${e.message}`);
        }

        await doClose();
        console.log(`[API] Métricas coletadas de ${host}.`);
    } catch (err) {
        console.error(`❌ [API] Falha ao conectar ou coletar métricas para ${host}: ${err.message}`);
        try { await doClose(); } catch (_) {}
    }
};

// --- 4. Ciclo Principal de Monitorização ---

const runMonitoringCycle = async () => {
    console.log('\n--- [CICLO DE MONITORIZAÇÃO] Iniciando... ---');
    const routerHosts = await getRoutersFromDB();
    console.log(`[CONFIG] Roteadores a serem monitorizados: ${routerHosts.join(', ')}`);

    // Processar cada roteador em paralelo
    await Promise.all(routerHosts.map(host => collectMetrics(host)));

    try {
        await writeApi.flush();
        console.log('[INFLUXDB] Lote de dados enviado com sucesso para a InfluxDB.');
    } catch (e) {
        console.error('❌ [INFLUXDB] Erro ao enviar dados:', e);
    }

    console.log('--- [CICLO DE MONITORIZAÇÃO] Ciclo concluído. A aguardar o próximo... ---');
};

const startAgent = () => {
    const intervalSeconds = 60;
    console.log(`[AGENTE DE MONITORIZAÇÃO] Serviço iniciado. A executar o ciclo de monitorização a cada ${intervalSeconds} segundos.`);
    
    // Executa imediatamente na primeira vez
    runMonitoringCycle();
    
    // E depois a cada X segundos
    setInterval(runMonitoringCycle, intervalSeconds * 1000);
};

startAgent();
