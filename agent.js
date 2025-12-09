// Carrega as variáveis de ambiente do ficheiro .env
const dotenv = require('dotenv');
const path = require('path');
// [MODIFICADO] Carrega o .env de forma explícita para garantir que o caminho está correto.
dotenv.config({ path: path.resolve(__dirname, '.env') });

const { Pool } = require('pg'); // [NOVO] Importa o driver do PostgreSQL
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

const INFLUX_URL = process.env.INFLUXDB_URL;
const INFLUX_TOKEN = process.env.INFLUXDB_TOKEN;
const INFLUX_ORG = process.env.INFLUXDB_ORG;
const INFLUX_BUCKET = process.env.INFLUXDB_BUCKET;

const MIKROTIK_API_PORT = process.env.MIKROTIK_API_PORT || 8728;
const MIKROTIK_USER = process.env.MIKROTIK_USER;
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD;

const DB_HOST = process.env.DB_HOST;
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_DATABASE = process.env.DB_DATABASE;
const DB_PORT = process.env.DB_PORT;

// Validação das variáveis de ambiente essenciais
if (!INFLUX_URL || !INFLUX_TOKEN || !INFLUX_ORG || !INFLUX_BUCKET) {
    console.error("❌ Erro: Uma ou mais variáveis de ambiente do InfluxDB (INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET) não estão definidas no seu ficheiro .env.");
    console.error("Por favor, verifique o seu ficheiro .env e tente novamente.");
    process.exit(1); // Termina o script com um código de erro.
}

/**
 * [MODIFICADO] Busca a lista de roteadores diretamente do banco de dados PostgreSQL.
 * Se as credenciais do banco não estiverem configuradas, usa a variável ROUTER_HOSTS como fallback.
 */
const getRoutersFromDB = async () => {
    // [MODIFICADO] Simplificado para usar apenas variáveis DB_*
    if (!DB_HOST || !DB_USER || !DB_DATABASE) {
        console.warn('[AVISO] Variáveis do PostgreSQL não configuradas. A usar ROUTER_HOSTS do .env como fallback.');
        if (!DB_HOST) console.warn('  - Causa: A variável de ambiente DB_HOST não foi encontrada no ficheiro .env.');
        return process.env.ROUTER_HOSTS ? process.env.ROUTER_HOSTS.split(',').map(h => h.trim()) : [];
    }

    const pool = new Pool({
        user: DB_USER, host: DB_HOST, database: DB_DATABASE, password: DB_PASSWORD, port: DB_PORT
    });

    try {
        const res = await pool.query("SELECT ip_address FROM routers WHERE ip_address IS NOT NULL AND ip_address <> ''");
        await pool.end();
        return res.rows.map(row => row.ip_address.trim());
    } catch (err) {
        console.error('❌ [PostgreSQL] Erro ao buscar roteadores do banco de dados:', err.message);
        await pool.end();
        return []; // Retorna um array vazio em caso de erro para não parar o agente.
    }
};

// --- 2. Cliente InfluxDB ---
const influxDB = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
const writeApi = influxDB.getWriteApi(INFLUX_ORG, INFLUX_BUCKET);
console.log(`[INFLUXDB] Cliente configurado para o bucket: ${INFLUX_BUCKET} 🚀`);

// Insira a seguir: utilitários e flattenAndWrite em escopo global
const sanitizeKey = (k) => String(k).replace(/[^a-zA-Z0-9_]/g,'_').replace(/^_+|_+$/g,'').toLowerCase();
const isNumericString = (s) => /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(String(s).trim());

/**
 * Converte a string de tempo do MikroTik (ex: 1w2d3h4m5s) para segundos.
 * @param {string} timeStr A string de tempo.
 * @returns {number} O total de segundos.
 */
const parseMikroTikTime = (timeStr) => {
    if (!timeStr || typeof timeStr !== 'string') return 0;
    
    let totalSeconds = 0;
    // Regex para capturar semanas, dias, horas, minutos e segundos
    const weeks = timeStr.match(/(\d+)w/);
    const days = timeStr.match(/(\d+)d/);
    const hours = timeStr.match(/(\d+)h/);
    const minutes = timeStr.match(/(\d+)m/);
    const seconds = timeStr.match(/(\d+)s/);

    if (weeks) totalSeconds += parseInt(weeks[1], 10) * 604800;
    if (days) totalSeconds += parseInt(days[1], 10) * 86400;
    if (hours) totalSeconds += parseInt(hours[1], 10) * 3600;
    if (minutes) totalSeconds += parseInt(minutes[1], 10) * 60;
    if (seconds) totalSeconds += parseInt(seconds[1], 10);

    return totalSeconds;
};

// Campos a serem completamente ignorados durante a coleta.
const ignoredFields = {
    'hotspot_active': new Set(['.id']),
    'system_resource': new Set([
        'cpu-count', 'total-memory', 'total-hdd-space', 'bad-blocks', 
        'write-sect-since-reboot', 'write-sect-total', 'architecture-name', 
        'board-name', 'platform', 'build-time', 'factory-software'
    ]),
    'system_clock': new Set([
        'gmt-offset', 'dst-active', 'time-zone-name', 'time-zone-autodetect'
    ]),
    'ip_arp': new Set([
        '.id', 'dynamic', 'complete', 'published'
    ]),
    'ip_dhcp_server_lease': new Set([
        '.id', 'radius', 'dynamic', 'blocked', 'disabled', 'dhcp-option',
        'age', 'expires-after', 'last-seen',
        'age_seconds', 'expires_after_seconds', 'last_seen_seconds'
    ]),
    'interface_stats': new Set([
        'mtu', 'actual-mtu', 'l2mtu', 'max-l2mtu',
        'fp-rx-byte', 'fp-tx-byte', 'fp-rx-packet', 'fp-tx-packet',
        'fp-rx-packets-per-second', 'fp-tx-packets-per-second',
        'fp-rx-bits-per-second', 'fp-tx-bits-per-second'
    ])
};

// Força campos específicos a serem tratados como STRING, mesmo que pareçam numéricos.
// Essencial para IDs, versões, MACs, etc.
const measurementForcedString = {
    'hotspot_active': new Set(['.id', 'server', 'user', 'address', 'mac-address', 'uptime', 'session-time-left', 'comment']),
    'interface_stats': new Set(['comment','default_name','disabled','.id','mac_address','running','slave','type']),
    'ip_address': new Set(['actual_interface','address','disabled','dynamic','id','interface','invalid','network']),
    'ip_arp': new Set(['address','dhcp','disabled','.id','interface','invalid','mac_address']),
    'ip_dhcp_server_lease': new Set(['active_address','active_client_id','active_mac_address','active_server','address','address_lists','client_id','host_name','server','status', 'mac-address']),
    'system_clock': new Set(['date','dst_active','gmt_offset','time_zone_autodetect','time_zone_name']),
    'system_health': new Set(['id','name','type']), // 'value' será tratado como número
    'system_resource': new Set(['architecture_name','board_name','build_time','factory_software','platform','version', 'uptime']),
    'system_routerboard': new Set(['board_name','current_firmware','factory_firmware','firmware_type','model','routerboard','serial_number','upgrade_firmware']),
    'user': new Set(['address','disabled','expired','group','id','last_logged_in','name'])
};

// Força campos específicos a serem tratados como NÚMEROS (inteiro ou float).
// Crucial para métricas, contadores e valores que serão usados em cálculos e gráficos.
const measurementForcedNumber = {
    // Métricas de interface: tráfego, erros, quedas.
    'interface_stats': new Set([
        'link_downs',
        'rx_byte','tx_byte','rx_packet','tx_packet','rx_drop','tx_drop','tx_queue_drop','rx_error','tx_error',
        'fp_rx_byte','fp_tx_byte','fp_rx_packet','fp_tx_packet',
        'rx_packets_per_second','tx_packets_per_second','rx_bits_per_second','tx_bits_per_second',
        'fp_rx_packets_per_second','fp_tx_packets_per_second','fp_rx_bits_per_second','fp_tx_bits_per_second',
        'rx_drops_per_second','tx_drops_per_second','rx_errors_per_second','tx_errors_per_second','tx_queue_drops_per_second'
    ]),
    // Métricas de recursos do sistema: CPU, memória, disco, etc.
    'system_resource': new Set([
        'cpu_load','free_memory','total_memory','free_hdd_space','total_hdd_space',
        'cpu_count','cpu_frequency','bad_blocks','write_sect_since_reboot','write_sect_total',
        'uptime_seconds' // Garante que a versão convertida seja numérica
    ]),
    // Métricas de saúde: voltagem, temperatura.
    'system_health': new Set(['value']),
};

const flattenAndWrite = (measurement, item, extraTags = {}, host) => {
    const meas = String(measurement).toLowerCase();
    const p = new Point(meas).tag('router_host', host || 'unknown');

    for (const [k, v] of Object.entries(extraTags || {})) p.tag(sanitizeKey(k), String(v));

    for (const [k, v] of Object.entries(item || {})) {
        if (v === undefined || v === null) continue;
        const sk = sanitizeKey(k);

        // Verifica se o campo deve ser ignorado
        if (ignoredFields[meas] && ignoredFields[meas].has(k)) {
            continue;
        }

        const raw = (typeof v === 'object') ? JSON.stringify(v) : String(v).trim();

        if (measurementForcedString[meas] && measurementForcedString[meas].has(sk)) {
            p.stringField(sk, raw);
            continue;
        }

        if (measurementForcedNumber[meas] && measurementForcedNumber[meas].has(sk)) {
            if (isNumericString(raw)) {
                if (raw.indexOf('.') !== -1 || /[eE]/.test(raw)) p.floatField(sk, Number(raw));
                else p.intField(sk, parseInt(raw, 10));
            } else {
                console.warn(`[AGENTE] Campo NUMÉRICO esperado ignorado (não-numérico): ${meas}.${sk}="${raw}" router=${host}`);
            }
            continue;
        }

        if (isNumericString(raw)) {
            if (raw.indexOf('.') !== -1 || /[eE]/.test(raw)) p.floatField(sk, Number(raw));
            else {
                const iv = parseInt(raw, 10);
                if (Number.isNaN(iv)) p.stringField(sk, raw); else p.intField(sk, iv);
            }
        } else {
            p.stringField(sk, raw);
        }
    }

    try {
        writeApi.writePoint(p);
    } catch (e) {
        console.error(`[INFLUXDB] Erro ao escrever ponto ${measurement}:`, e.message);
    }
};

/**
 * Coleta os usuários ativos do Hotspot.
 */
const getHotspotActiveUsers = async (host, client, writer, runCommand) => {
    try {
        const hotspotUsers = await runCommand('/ip/hotspot/active/print');
        if (hotspotUsers && hotspotUsers.length > 0) {
            console.log(`[API-DEBUG] Encontrados ${hotspotUsers.length} usuários ativos no Hotspot em ${host}.`);
            hotspotUsers.forEach(user => {
                // O 'user' pode não existir para clientes não autenticados, mas o mac_address sim.
                const tags = user.user ? { user: user.user } : {};
                writer('hotspot_active', user, tags, host);
            });
        }
    } catch (e) {
        // Não é um erro crítico se o hotspot não estiver configurado.
        console.warn(`[API] Aviso ao coletar usuários ativos do Hotspot em ${host}: ${e.message}`);
    }
};

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

    // [NOVO] Adiciona um listener de erro para prevenir que o processo caia.
    // O erro de timeout é um evento 'error' que, se não for capturado, quebra a aplicação.
    client.on('error', (err) => {
        // Apenas registamos o evento aqui. O tratamento principal do erro (a mensagem para o utilizador)
        // já é feito no bloco `catch` principal desta função.
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

    try {
        await doConnect();
        console.log(`[API] Conectado com sucesso a ${host}. Coletando métricas...`);

        // --- Verificação de Capacidades (Capabilities) ---
        const packages = await runCommand('/system/package/print');
        console.log(`[API-DEBUG] Pacotes instalados em ${host}:`, JSON.stringify(packages.map(p => ({ name: p.name, disabled: p.disabled }))));
        const isWave2Enabled = packages.some(pkg => pkg.name === 'wifiwave2' && pkg.disabled === 'false');
        const isLegacyWirelessEnabled = packages.some(pkg => pkg.name === 'wireless' && pkg.disabled === 'false');

        // --- Construção da Lista de Comandos Dinâmica ---
        // [MODIFICADO] Comandos removidos e duplicatas limpas.
        const commands = [
            '/system/resource/print',      // Métricas vitais: CPU, memória, uptime
            '/system/clock/print',         // Data e hora do sistema
            '/ip/address/print',           // Endereços IP configurados,
            '/ip/arp/print',               // Tabela ARP (IPs e MACs na rede)
            '/ip/dhcp-server/lease/print', // Clientes DHCP ativos
            '/user/print'                  // Utilizadores configurados no router
        ];

        if (isWave2Enabled) {
            console.log(`[API] Pacote wireless 'wifiwave2' detectado em ${host}. Coletando métricas de Wi-Fi.`);
            commands.push('/interface/wifiwave2/registration-table/print');
        } else if (isLegacyWirelessEnabled) {
            console.log(`[API] Pacote wireless 'wireless' detectado em ${host}. Coletando métricas de Wi-Fi.`);
            commands.push('/interface/wifiwave2/registration-table/print');
        } else {
            console.log(`[API] Pacote wireless não detectado ou desativado em ${host}. Pulando métricas de Wi-Fi.`);
        }

        for (const cmd of commands) {
            try {
                const res = await runCommand(cmd);
                if (!res) continue;

                // normaliza para array
                const rows = Array.isArray(res) ? res : (res ? [res] : []);
                let baseMeasurement = cmd
                    .replace(/^\//, '')
                    .replace(/\/print$/, '')
                    .replace(/\//g, '_') || 'unknown';

                // [NOVO] Normaliza o nome da medição de Wi-Fi para consistência,
                // independentemente do pacote (legacy vs wave2).
                if (baseMeasurement === 'interface_wifiwave2_registration_table') {
                    baseMeasurement = 'interface_wireless_registration_table';
                }

                // escreve cada item como ponto separado
                rows.forEach(row => {
                    // [NOVO] Converte campos de tempo específicos para segundos
                    if (baseMeasurement === 'system_resource' && row.uptime) {
                        row.uptime_seconds = parseMikroTikTime(row.uptime);
                    }
                    if (baseMeasurement === 'ip_dhcp_server_lease') {
                        if (row.age) row.age_seconds = parseMikroTikTime(row.age);
                        if (row.expires_after) row.expires_after_seconds = parseMikroTikTime(row.expires_after);
                        if (row.last_seen) row.last_seen_seconds = parseMikroTikTime(row.last_seen);
                    }
                    flattenAndWrite(baseMeasurement, row, {}, host);
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
                const name = iface.name;
                if (!name) continue;

                // Combina os dados estáticos (iface) com os dados de tráfego em tempo real
                // SOLUÇÃO: Passa os argumentos como um array para lidar com espaços nos nomes
                const trafficStats = await runCommand(
                    '/interface/monitor-traffic', 
                    [`=interface=${name}`, '=once=yes']
                );
                const combinedData = Object.assign({}, iface, trafficStats[0] || {});

                // [NOVO] Remove a propriedade 'name' do objeto de dados para evitar redundância,
                // uma vez que já estamos a passá-la como uma tag 'interface_name'.
                // Isso garante que não haja confusão entre um campo 'name' e uma tag 'interface_name'.
                delete combinedData.name;

                // Escreve um único ponto de dados com todas as informações da interface
                flattenAndWrite('interface_stats', combinedData, { interface_name: name }, host);
            }
        } catch (e) {
            console.warn(`[API] Falha ao coletar métricas de interface em ${host}: ${e.message}`);
        }

        // Coleta de usuários do Hotspot
        try {
            if (typeof getHotspotActiveUsers === 'function') {
                await getHotspotActiveUsers(host, client, flattenAndWrite, runCommand);
            } else {
                console.warn(`[API] Função getHotspotActiveUsers não definida — pulando coleta de usuários Hotspot para ${host}.`);
            }
        } catch (err) {
            console.error(`[API] Falha ao conectar ou coletar métricas para ${host}: ${err.message}`);
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
