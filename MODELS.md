# Modèles disponibles dans le workspace Dust

Catalogue **fournisseur** : les LLM que le workspace peut exécuter. C'est la
sortie de :

```bash
docker compose exec proxy proxyctl models      # [--all] [--json]
```

À ne pas confondre avec `models.json`, qui associe les noms de modèles envoyés
par Claude Code à des **agents** Dust (par `sId`, par nom d'agent, ou par
`modelId` — ce catalogue-ci fournit les `modelId` utilisables). Pour lister les
agents et leurs `sId`, utiliser `proxyctl agents`.

| Provider | Model ID | Nom | Contexte | Max out | Drapeaux |
| --- | --- | --- | ---: | ---: | --- |
| openai | `gpt-6-astra` | GPT 6 Astra | 272k | 64k | latest vision reasoning:light/medium/high |
| openai | `gpt-6-sol` | GPT 6 Sol | 272k | 64k | latest vision reasoning:none/light/medium/high |
| openai | `gpt-6-luna` | GPT 6 Luna | 272k | 64k | latest vision reasoning:none/light/medium/high |
| openai | `gpt-5.6-sol` | GPT 5.6 Sol | 272k | 64k | vision reasoning:none/light/medium/high |
| openai | `gpt-5.6-terra` | GPT 5.6 Terra | 272k | 64k | latest vision reasoning:none/light/medium/high |
| openai | `gpt-5.6-luna` | GPT 5.6 Luna | 272k | 64k | vision reasoning:none/light/medium/high |
| openai | `gpt-5.4-mini` | GPT-5.4 Mini | 400k | 128k | vision reasoning:none/light/medium/high |
| openai | `gpt-5.4-nano` | GPT-5.4 Nano | 400k | 128k | vision reasoning:none/light/medium/high |
| anthropic | `claude-opus-5-5` | Claude Opus 5.5 | 250k | 64k | latest vision reasoning:light/medium/high |
| anthropic | `claude-opus-5` | Claude Opus 5 | 250k | 64k | vision reasoning:light/medium/high |
| anthropic | `claude-sonnet-5` | Claude Sonnet 5 | 250k | 64k | latest vision reasoning:light/medium/high |
| anthropic | `claude-opus-4-8` | Claude Opus 4.8 | 250k | 64k | vision reasoning:light/medium/high |
| anthropic | `claude-sonnet-4-6` | Claude Sonnet 4.6 | 250k | 64k | vision reasoning:light/medium/high |
| anthropic | `claude-haiku-4-5-20251001` | Claude 4.5 Haiku | 180k | 64k | latest vision reasoning:light/medium/high |
| mistral | `mistral-large-latest` | Mistral Large | 256k | 2k | latest vision reasoning:none |
| mistral | `mistral-medium-3-5` | Mistral Medium 3.5 | 256k | 2k | latest vision reasoning:none/high |
| mistral | `mistral-small-latest` | Mistral Small | 128k | 2k | vision reasoning:none |
| mistral | `codestral-latest` | Mistral Codestral | 128k | 2k | reasoning:none |
| google_ai_studio | `gemini-3.8-flash` | Gemini 3.8 Flash | 1049k | 66k | latest vision reasoning:light/medium/high |
| google_ai_studio | `gemini-3.7-flash` | Gemini 3.7 Flash | 1000k | 64k | vision reasoning:light/medium/high |
| google_ai_studio | `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | 1000k | 64k | latest vision reasoning:none/light/medium/high |
| google_ai_studio | `gemini-3.1-pro-preview` | Gemini 3.1 Pro (Preview) | 1000k | 64k | latest vision reasoning:light/medium/high |
| google_ai_studio | `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | 1000k | 64k | vision reasoning:none/light/medium/high |
| fireworks | `accounts/fireworks/models/deepseek-v4p1-flash` | DeepSeek V4.1 Flash | 256k | 64k | latest vision reasoning:none/light/medium/high |
| fireworks | `accounts/fireworks/models/kimi-k3` | Kimi K3 | 256k | 64k | latest vision reasoning:light/medium/high |
| fireworks | `accounts/fireworks/models/glm-5p3` | GLM-5.3 | 1000k | 128k | latest reasoning:light/medium/high |
| fireworks | `accounts/fireworks/models/glm-5p3-flash` | GLM-5.3 Flash | 256k | 64k | latest vision reasoning:light/medium/high |
| fireworks | `accounts/fireworks/models/inkling` | Inkling | 1000k | 64k | latest vision reasoning:light/medium/high |
| auto_fast | `auto_fast` | Basic | 1000k | 64k | latest reasoning:none |
| auto | `auto` | Standard | 1000k | 64k | latest reasoning:none |
| auto_complex | `auto_complex` | Premium | 1000k | 64k | latest reasoning:none |

Les trois dernières lignes (`auto_fast`, `auto`, `auto_complex`) ne sont pas de
vrais modèles mais les paliers de routage de Dust ; `proxyctl models` affiche en
fin de sortie le modèle concret vers lequel chacun pointe actuellement.

Ce catalogue est un instantané : relancer `proxyctl models` pour l'état courant.
