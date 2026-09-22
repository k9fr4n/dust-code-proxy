# dust-code-proxy

Proxy spécialisé **Claude Code CLI → Dust AI**. Il traduit les requêtes de l'API
Messages d'Anthropic vers l'API Dust (OAuth device-code, conversations, streaming
SSE en deux temps), pour lancer Claude Code avec `ANTHROPIC_BASE_URL` pointé vers
ce proxy.

> Périmètre : le proxy couvre les étapes 0→5 (login, conversation, streaming, mapping
> de modèles, et pont d'outils MCP). Le pont MCP déclare les outils locaux de Claude
> Code (`Bash`, `Read`, `Write`, `Grep`, …) sur un serveur MCP enregistré auprès de
> Dust, afin que l'agent Dust puisse les invoquer en cours de tour.

## Démarrage rapide

```bash
cp .env.example .env          # puis ajuster PROXY_API_KEYS au minimum
docker compose up -d --build
docker compose run --rm proxy login
# → ouvre l'URL affichée dans ton navigateur, saisis le code, sélectionne le workspace
```

Lancer Claude Code :

```bash
ANTHROPIC_BASE_URL="http://localhost:8080" \
ANTHROPIC_API_KEY="local-proxy-key" \
ANTHROPIC_MODEL="dust-coding-agent" \
claude
```

Test minimal :

```bash
ANTHROPIC_BASE_URL="http://localhost:8080" \
ANTHROPIC_API_KEY="local-proxy-key" \
ANTHROPIC_MODEL="dust-coding-agent" \
claude -p "Reply with OK only."
```

## Configuration

### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PROXY_API_KEYS` | `local-proxy-key` | Clés acceptées en `x-api-key` (séparées par des virgules). |
| `DUST_OAUTH_CLIENT_ID` | `client_01JGCT55T7FVDG9XF74925R1KT` | Client OAuth public WorkOS (device flow). |
| `DUST_CREDENTIAL_FILE` | `/data/dust-credentials.json` | Emplacement des credentials persistés. |
| `DUST_BASE_URL` | `https://dust.tt` | Repli si la région n'est pas déduite du JWT. |
| `DUST_SPACE_ID` | *(vide)* | `spaceId` optionnel pour les workspaces organisés par espaces. |
| `DUST_DEFAULT_AGENT_CONFIGURATION_ID` | *(vide)* | Agent utilisé si un modèle n'est pas dans `models.json`. |
| `DUST_FORWARD_SYSTEM` | `true` | Prépender le champ `system` de Claude Code au contenu du message. |
| `DUST_MCP_SERVER_NAME` | `claude-code-proxy` | Nom du serveur MCP enregistré auprès de Dust (5–30 caractères). |
| `DUST_MCP_HEARTBEAT_INTERVAL_MS` | `240000` | Période du heartbeat MCP (Dust impose ≤ 5 min ; marge de sécurité). |
| `DUST_MCP_RECONNECT_DELAY_MS` | `5000` | Délai de reconnexion du flux SSE `mcp/requests`. |
| `INTERNAL_TOKEN` | *(vide)* | Active les endpoints `/internal/*` si défini. |
| `PORT` | `8080` | Port d'écoute. |

### Mapping modèle → agent Dust

Éditer `models.json` :

```json
{
  "dust-coding-agent": { "configurationId": "cfg_coding" },
  "dust-fast-agent": { "configurationId": "cfg_fast" },
  "claude-sonnet-4-5": { "configurationId": "cfg_coding" },
  "claude-opus-4-6": { "configurationId": "cfg_coding" },
  "claude-haiku-4-5": { "configurationId": "cfg_fast" }
}
```

Les `configurationId` sont les `sId` réels de tes agents Dust (visibles via
`GET assistant/agent_configurations`). Au démarrage (et sur `GET /v1/models`), le
proxy rafraîchit cette liste et log un avertissement si un id mappé n'existe pas.

Résolution d'un `model` : entrée de `models.json` → `DUST_DEFAULT_AGENT_CONFIGURATION_ID`
→ nom/`sId` d'agent connu. Sinon erreur `not_found_error`.

## Endpoints

| Endpoint | Rôle |
|---|---|
| `POST /v1/messages` | Traduction des messages (stream + non-stream). |
| `GET /health` | État global + `dust_auth`. |
| `GET /health/dust` | État d'authentification Dust (ttl du token, workspace). |
| `GET /v1/models` | Liste de confort (mapping + agents découverts). |
| `POST /internal/sessions` | Créer/consulter une session (clé `session`). |
| `DELETE /internal/sessions/:id` | Réinitialiser une session (mapping local uniquement). |

## Identification de session

La conversation Dust est réutilisée par session Claude Code. L'ordre de résolution :

1. header `x-dust-session` ;
2. `metadata.user_id` ;
3. à défaut, une conversation par clé proxy.

Pour isoler plusieurs sessions sous une même clé, utiliser un wrapper :

```bash
export ANTHROPIC_BASE_URL="http://localhost:8080"
export ANTHROPIC_API_KEY="local-proxy-key"
claude --append-system-prompt ""   # (exemple) ou transmettre x-dust-session via un proxy intermédiaire
```

## Pont d'outils MCP (étape 5)

Quand une requête `/v1/messages` contient un tableau `tools` non vide (en mode
streaming), le proxy déclare ces outils sur un serveur MCP enregistré auprès de Dust
(`mcp/register`), en passant `clientSideMCPServerIds` dans le contexte du message.
Pendant le tour :

1. Dust appelle un outil via le flux SSE `mcp/requests` (`tools/call`) ;
2. le proxy relaie l'appel à Claude Code sous forme de bloc `tool_use`, puis clôture
   le tour avec `stop_reason: tool_use` — **sans** annuler la génération Dust ;
3. Claude Code exécute l'outil localement et renvoie un bloc `tool_result` dans sa
   requête suivante ;
4. le proxy poste le résultat à Dust via `mcp/results` et reprend le streaming du
   même message Dust (`lastEventId`) pour émettre la suite.

Le transport implémente le heartbeat (ré-enregistrement immédiat en cas d'échec) et
la reconnexion indéfinie du flux SSE sur erreur. La validation des `input_schema` des
outils se fait par conversion JSON-Schema → Zod (sous-ensemble courant ; repli vers un
objet libre pour les schémas exotiques).

## Erreurs et annulation

Les erreurs sont renvoyées au format Anthropic (`{"type":"error","error":{...}}`).
Une déconnexion de Claude Code en cours de streaming déclenche
`POST assistant/conversations/{id}/cancel` côté Dust.

## Développement

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev            # serveur en watch (tsx)
```

## Limites connues

- Les blocs `image`/`document` (contenu non-textuel autre que les outils) restent
  refusés en entrée. Les tours `tool_result` nécessitent le mode streaming.
- Les métriques de tokens sont renvoyées à `0` (Dust ne les expose pas au format
  Anthropic).
- `generation_tokens.classification` est pour l'instant mappé en texte simple (le
  mapping vers les blocs `thinking` reste à faire une fois les valeurs observées).
- Stockage de session en mémoire (une seule instance).
