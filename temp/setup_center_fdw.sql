-- 1. Habilitar a extensão postgres_fdw se não existir
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- 2. Criar o Foreign Server apontando para o banco remoto center2
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = 'center_server') THEN
        CREATE SERVER center_server
        FOREIGN DATA WRAPPER postgres_fdw
        OPTIONS (host 'contracte.net', port '5487', dbname 'center2');
    END IF;
END $$;

-- 3. Criar o mapeamento do usuário postgres
DROP USER MAPPING IF EXISTS FOR postgres SERVER center_server;
CREATE USER MAPPING FOR postgres
SERVER center_server
OPTIONS (user 'postgres', password 'VJvj5141');

-- 4. Criar o esquema center (se não existir)
CREATE SCHEMA IF NOT EXISTS center;

-- 5. Importar as tabelas estrangeiras do banco remoto
IMPORT FOREIGN SCHEMA public LIMIT TO (contato, consulta, consultaresultado, contatofone, convenio)
FROM SERVER center_server INTO center;

-- 6. Criar a Materialized View no esquema center para consolidar os dados das consultas recentes
DROP MATERIALIZED VIEW IF EXISTS center.recent_consultas_mv CASCADE;

CREATE MATERIALIZED VIEW center.recent_consultas_mv AS
WITH latest_consulta AS (
    SELECT 
        c.contid,
        c.contcpf,
        c.contnome,
        cons.consid,
        cr.resconvenio,
        cr.resmatricula,
        cr.resparcela,
        cr.resmgconsig,
        cr.resmgtotconsig,
        cr.resconvid,
        row_number() OVER (PARTITION BY c.contid ORDER BY cons.consid DESC, cr.resid DESC) as rn
    FROM center.contato c
    JOIN center.consulta cons ON cons.conscontatoid = c.contid
    JOIN center.consultaresultado cr ON cr.consid = cons.consid
    WHERE cons.constipo IN ('PORTAL', 'MASTER_API', 'MASTER_API_EX')
)
SELECT 
    lc.contnome AS nome_completo,
    conv.convdesc AS convenio,
    split_part(lc.contnome, ' ', 1) AS primeiro_nome,
    lc.resparcela AS valor_comprometimento,
    lc.resmatricula AS matricula,
    ((lc.resmgtotconsig - lc.resmgconsig) * 0.2) AS reducao_valor,
    (((lc.resmgtotconsig - lc.resmgconsig) * 0.2) * 96) AS montante_reducao,
    lc.contcpf AS cpf,
    lc.contid AS contato_id,
    cf.fonenumero AS fone_whats_informado
FROM latest_consulta lc
LEFT JOIN center.convenio conv ON lc.resconvid = conv.convid
JOIN center.contatofone cf ON cf.contid = lc.contid
WHERE lc.rn = 1;

-- 7. Criar índices para performance em poucos ms
CREATE UNIQUE INDEX IF NOT EXISTS idx_recent_consultas_uniq ON center.recent_consultas_mv (cpf, fone_whats_informado);
CREATE INDEX IF NOT EXISTS idx_recent_consultas_contato_id ON center.recent_consultas_mv (contato_id);
