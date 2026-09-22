# Agents Dust disponibles

Liste des agents Dust du workspace (nom → sId), pour remplir `models.json`
ou `DUST_DEFAULT_AGENT_CONFIGURATION_ID`.

## Exemple de routage

`models.json` mappe un **modèle** (la valeur de `ANTHROPIC_MODEL`, sensible à la casse)
vers un agent Dust :

```json
{
  "claude-sonnet-5":  { "configurationId": "dLy1V6JMMD" },
  "claude-opus-5":    { "configurationId": "AcqnwSyy7X" },
  "claude-4.5-haiku": { "configurationId": "ggKOhTwS8Y" }
}
```

Sans entrée correspondante, le proxy retombe sur `DUST_DEFAULT_AGENT_CONFIGURATION_ID`.

## Agents (nom → sId)

| Nom | sId |
| --- | --- |
| help | `helper` |
| dust | `dust` |
| deep-dive | `deep-dive` |
| Claude_4.5_Haiku | `ggKOhTwS8Y` |
| Claude_Opus_4.7 | `z2HGYsuGK9` |
| Claude_Opus_4.8 | `RhBIx43D31` |
| Claude_Opus_5 | `AcqnwSyy7X` |
| Claude_Sonnet_5 | `dLy1V6JMMD` |
| CoachSportif | `zM1KrvMBuA` |
| DeepSeek_V4_Flash | `ZbRlBVVhKn` |
| DeepSeek_V4_Pro | `R6ngzOLYky` |
| EUDONET | `yxoJbkIo9E` |
| gemini_3.1_flash_lite | `vKlPXzu04M` |
| Gemini_3.1_Pro_Light | `aWhpI3f5NV` |
| Gemini_3.7_Flash_Light | `fJKmwT1kgk` |
| GeminiFlash | `ndqxZ1vu5s` |
| GLM-5.2 | `4SwINqW6jM` |
| GPT_5.6_Luna | `6kvfVFW2pU` |
| GPT_5.6_Sol | `VGtoCTcIyq` |
| GPT_5.6_Terra | `AEibOi8uBK` |
| GTP_6_ASTRA | `A1Nkjixwhm` |
| Imager | `yyEPVXukeP` |
| Interne | `PwEHxDbV1I` |
| KDustCoder | `SutxSaDW3Y` |
| Kimi_K3 | `3ET2GwfGYs` |
| KungFuMaster | `4PYH13fOBs` |
| OPTAVIS | `CB3vuTzbqM` |
| OPUS | `7azUWpqJi2` |
| PSAuditor | `E3dnpHFniO` |
| PSCoder | `ICxLwKnsHP` |
| PSWinOps | `YAHEL4kAOi` |
| StravaDashboardAI | `ow1BRXWVRs` |
| TFProviderExpert | `GChx6I2FD5` |
| ThrukMCPBridge | `y8sifD1Gxs` |
| WALLIX | `YYxnHVC0hA` |
| WAM | `f2GMVUtesj` |
| WAMIMG | `0FcA7idZ1E` |
| WinEngineer | `6ZtSNMVBpF` |
