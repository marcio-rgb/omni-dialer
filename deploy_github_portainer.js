import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Helper to extract GitHub token dynamically from remote URL
function getGitHubConfig() {
    try {
        const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
        const match = remoteUrl.match(/https:\/\/([^@]+)@github\.com\/([^\/]+)\/([^\.]+)/);
        if (match) {
            return {
                token: match[1],
                owner: match[2],
                repo: match[3]
            };
        }
    } catch (err) {
        console.warn('⚠️ Could not parse git remote config:', err.message);
    }
    // Fallback
    return {
        token: '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',
        owner: 'marcio-rgb',
        repo: 'omni-dialer'
    };
}

// 2. Helper to load Portainer config from dialer/.env or chat/.env
function getPortainerConfig() {
    const pathsToCheck = [
        path.join(__dirname, '../ecosystem/.env'),
        path.join(__dirname, '../ecosystem/.ENV'),
        path.join(__dirname, '.env'),
        path.join(__dirname, '../chat/.env')
    ];

    for (const p of pathsToCheck) {
        if (fs.existsSync(p)) {
            const content = fs.readFileSync(p, 'utf8');
            const keyMatch = content.match(/PORTAINER_KEY_PROD\s*=\s*["']?([^"'\r\n]+)/);
            const urlMatch = content.match(/PORTAINER_URL_PROD\s*=\s*["']?([^"'\r\n]+)/);
            
            if (keyMatch && urlMatch) {
                let url = urlMatch[1].trim();
                if (!url.endsWith('/api')) {
                    url = `${url}/api`;
                }
                return {
                    key: keyMatch[1].trim(),
                    url: url
                };
            }
        }
    }
    
    // Fallback
    return {
        key: 'ptr_ubSfIbjJaga7zSenoBqm8mTPzWvccL/jIuWo3t9k6bQ=',
        url: 'https://portainer.creditobr.org/api'
    };
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('🚀 === INICIANDO AUTOMATIZAÇÃO DE DEPLOY DO DIALER ===');

    const composePath = path.join(__dirname, 'docker-compose.yml');
    if (!fs.existsSync(composePath)) {
        console.error('❌ docker-compose.yml não encontrado no diretório do dialer.');
        process.exit(1);
    }

    const epoch = Math.floor(Date.now() / 1000);

    // --- PASSO 1: Atualizar UPDATE_TIMESTAMP no docker-compose.yml local ---
    console.log('\n📝 1. Atualizando UPDATE_TIMESTAMP no docker-compose.yml...');
    try {
        let composeContent = fs.readFileSync(composePath, 'utf8');
        if (composeContent.includes('UPDATE_TIMESTAMP=')) {
            composeContent = composeContent.replace(/UPDATE_TIMESTAMP=\d+/g, `UPDATE_TIMESTAMP=${epoch}`);
        } else {
            console.error('❌ Linha UPDATE_TIMESTAMP não encontrada no docker-compose.yml');
            process.exit(1);
        }
        fs.writeFileSync(composePath, composeContent, 'utf8');
        console.log(`✅ UPDATE_TIMESTAMP atualizado para: ${epoch}`);
    } catch (err) {
        console.error('❌ Falha ao atualizar o arquivo docker-compose.yml:', err.message);
        process.exit(1);
    }

    // --- PASSO 2: Commit e push das alterações ---
    console.log('\n🔄 2. Realizando commit e push para o GitHub...');
    let commitMessage = process.argv[2] || '';
    if (!commitMessage) {
        try {
            const diffFiles = execSync('git diff --name-only', { encoding: 'utf8' })
                .trim()
                .split('\n')
                .filter(f => f.trim().length > 0 && !f.includes('docker-compose.yml'));

            if (diffFiles.length > 0) {
                commitMessage = `feat(prod): auto-deploy - updated ${diffFiles.map(f => path.basename(f)).slice(0, 5).join(', ')}`;
            } else {
                commitMessage = 'chore: trigger production dialer deploy';
            }
        } catch (err) {
            commitMessage = 'chore: trigger production dialer deploy';
        }
    }

    try {
        // Garantir que a identidade do git está configurada
        try {
            execSync('git config user.email || git config --global user.email "marcio@fastmob.com.br"');
            execSync('git config user.name || git config --global user.name "marcio-rgb"');
        } catch (gitErr) {
            // Ignorar se já estiver configurado
        }

        execSync('git add .', { stdio: 'inherit' });
        const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
        if (status.length > 0) {
            execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
        } else {
            console.log('No modifications to commit.');
        }
        console.log('📤 Enviando alterações para o repositório GitHub (main)...');
        execSync('git push origin main --force', { stdio: 'inherit' });
    } catch (err) {
        console.error('❌ Falha ao realizar commit/push das alterações:', err.message);
        process.exit(1);
    }

    const commitSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    console.log(`📌 Commit SHA atual: ${commitSha}`);

    // --- PASSO 3: Monitorar workflow do GitHub Actions ---
    console.log('\n⏳ 3. Aguardando workflow do GitHub Actions compilar a imagem do dialer...');
    const gitConfig = getGitHubConfig();
    let buildSuccess = false;
    const startTime = Date.now();

    while (true) {
        if (Date.now() - startTime > 15 * 60 * 1000) {
            console.error('❌ Timeout de build no GitHub atingido (15 min).');
            process.exit(1);
        }

        try {
            const res = await fetch(`https://api.github.com/repos/${gitConfig.owner}/${gitConfig.repo}/actions/runs`, {
                headers: {
                    'User-Agent': 'DeployScript',
                    'Authorization': `Bearer ${gitConfig.token}`
                }
            });

            if (!res.ok) {
                throw new Error(`GitHub API HTTP ${res.status} ${res.statusText}`);
            }

            const data = await res.json();
            const runs = data.workflow_runs;
            const currentRun = runs.find(run => run.head_sha === commitSha);

            if (currentRun) {
                console.log(`   - Status: ${currentRun.status} | Conclusão: ${currentRun.conclusion || 'Em andamento...'}`);
                
                if (currentRun.status === 'completed') {
                    if (currentRun.conclusion === 'success') {
                        buildSuccess = true;
                        console.log('✅ COMPILAÇÃO CONCLUÍDA COM SUCESSO NO GITHUB ACTIONS!');
                        break;
                    } else {
                        console.error(`❌ Falha no build do GitHub. Status final: ${currentRun.conclusion}`);
                        process.exit(1);
                    }
                }
            } else {
                console.log('   - Aguardando início do workflow no GitHub...');
            }
        } catch (err) {
            console.warn('⚠️ Erro ao consultar API do GitHub:', err.message);
        }

        await sleep(15000);
    }

    // --- PASSO 4: Deploy da Stack no Portainer de Produção ---
    if (buildSuccess) {
        console.log('\n🐳 4. Iniciando deploy da Stack 40 no Portainer de produção...');
        const pConfig = getPortainerConfig();
        const stackId = 40;
        const endpointId = 1;

        try {
            console.log('   - Lendo conteúdo do docker-compose.yml atualizado...');
            const composeContent = fs.readFileSync(composePath, 'utf8');

            console.log('   - Enviando requisição de atualização para a stack do Portainer...');
            const resUpdate = await fetch(`${pConfig.url}/stacks/${stackId}?endpointId=${endpointId}`, {
                method: 'PUT',
                headers: {
                    'X-API-Key': pConfig.key,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    StackFileContent: composeContent,
                    Env: [],
                    Prune: true,
                    PullImage: true
                })
            });

            if (!resUpdate.ok) {
                const errText = await resUpdate.text();
                throw new Error(`Portainer Stack Update API HTTP ${resUpdate.status}: ${errText}`);
            }

            console.log('✅ STACK DO DIALER ATUALIZADA E RECREADA COM SUCESSO NO PORTAINER!');
            console.log('🎉 PROCESSO DE DEPLOY COMPLETO CONCLUÍDO!');
        } catch (err) {
            console.error('❌ Falha ao atualizar a Stack no Portainer:', err.message);
            process.exit(1);
        }
    }
}

main();
