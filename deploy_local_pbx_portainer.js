import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getLocalPortainerConfig() {
    const pathsToCheck = [
        path.join(__dirname, '../ecosystem/.env'),
        path.join(__dirname, '../ecosystem/.ENV'),
        path.join(__dirname, '.env')
    ];

    let key = 'ptr_tJZgg+Er87puS0bPv0A4z5wp5vePkwuZkzKZaOO0U+o=';
    let url = 'http://192.168.0.17:9000/api';

    for (const p of pathsToCheck) {
        if (fs.existsSync(p)) {
            const content = fs.readFileSync(p, 'utf8');
            const keyMatch = content.match(/(?:PORTAINER_LOCAL_KEY|PORTAINER_KEY)\s*=\s*["']?([^"'\r\n]+)/);
            const urlMatch = content.match(/PORTAINER_LOCAL_URL\s*=\s*["']?([^"'\r\n]+)/);
            
            if (keyMatch) key = keyMatch[1].trim();
            if (urlMatch) {
                let u = urlMatch[1].trim();
                url = u.endsWith('/api') ? u : `${u}/api`;
            }
        }
    }

    return { key, url };
}

async function main() {
    console.log('🚀 === DEPLOY NATIVO DO PBX EDGE NO PORTAINER LOCAL (192.168.0.17) ===');

    const config = getLocalPortainerConfig();
    const composePath = path.join(__dirname, 'docker-compose.pbx.yml');
    
    if (!fs.existsSync(composePath)) {
        console.error('❌ Arquivo docker-compose.pbx.yml não encontrado!');
        process.exit(1);
    }

    const composeContent = fs.readFileSync(composePath, 'utf8');
    const stackName = 'omnichat-pbx';

    try {
        console.log(`\n🔍 1. Consultando Endpoints no Portainer (${config.url})...`);
        const epRes = await fetch(`${config.url}/endpoints`, {
            headers: { 'X-API-Key': config.key }
        });

        if (!epRes.ok) {
            throw new Error(`Portainer API HTTP ${epRes.status}: ${await epRes.text()}`);
        }

        const endpoints = await epRes.json();
        const localEndpoint = endpoints.find(e => e.Name === 'local' || e.Type === 1) || endpoints[0];

        if (!localEndpoint) {
            throw new Error('Nenhum endpoint Docker encontrado no Portainer local!');
        }

        const endpointId = localEndpoint.Id;
        console.log(`   ✓ Endpoint selecionado: ${localEndpoint.Name} (ID: ${endpointId})`);

        console.log(`\n📦 2. Verificando Stack "${stackName}"...`);
        const stacksRes = await fetch(`${config.url}/stacks`, {
            headers: { 'X-API-Key': config.key }
        });
        const stacks = await stacksRes.json();
        const existingStack = stacks.find(s => s.Name === stackName);

        const authObj = {
            username: 'marcio-rgb',
            password: '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',
            serveraddress: 'ghcr.io'
        };
        const authHeader = Buffer.from(JSON.stringify(authObj)).toString('base64');

        if (existingStack) {
            console.log(`   - Atualizando Stack existente ID ${existingStack.Id}...`);
            const updateRes = await fetch(`${config.url}/stacks/${existingStack.Id}?endpointId=${endpointId}`, {
                method: 'PUT',
                headers: {
                    'X-API-Key': config.key,
                    'Content-Type': 'application/json',
                    'X-Registry-Auth': authHeader
                },
                body: JSON.stringify({
                    stackFileContent: composeContent,
                    env: [],
                    prune: true,
                    pullImage: true
                })
            });

            if (!updateRes.ok) {
                throw new Error(`Falha ao atualizar stack: ${await updateRes.text()}`);
            }

            console.log('✅ STACK DO PBX ATUALIZADA COM SUCESSO NO PORTAINER!');
        } else {
            console.log(`   - Criando nova Stack gerenciada "${stackName}"...`);
            const createRes = await fetch(`${config.url}/stacks/create/standalone/string?endpointId=${endpointId}`, {
                method: 'POST',
                headers: {
                    'X-API-Key': config.key,
                    'Content-Type': 'application/json',
                    'X-Registry-Auth': authHeader
                },
                body: JSON.stringify({
                    name: stackName,
                    stackFileContent: composeContent,
                    env: []
                })
            });

            if (!createRes.ok) {
                throw new Error(`Falha ao criar stack: ${await createRes.text()}`);
            }

            const created = await createRes.json();
            console.log(`✅ STACK DO PBX CRIADA COM SUCESSO! (ID: ${created.Id})`);
        }

        console.log('\n🎉 Deploy concluído! A stack agora é 100% gerenciada pelo Portainer.');
    } catch (err) {
        console.error('❌ Erro durante o deploy no Portainer:', err.message);
        process.exit(1);
    }
}

main();
