# Event4U Print Agent

App desktop per la stampa termica di biglietti SIAE-compliant.

## URL Server Integrato
`https://manage.eventfouryou.com`

## Installazione Sviluppo

```bash
cd print-agent-desktop
npm install
npm start
```

## Compilazione Eseguibile

### Windows
```bash
npm run build:win
```
L'eseguibile sarà in `dist/Event4U Print Agent Setup.exe`

### Mac
```bash
npm run build:mac
```
Il file .dmg sarà in `dist/`

## Configurazione

1. **Nel sito web Event4U** (come admin/gestore):
   - Vai a "Impostazioni Stampanti"
   - Clicca "Registra Nuovo Agente"
   - Inserisci il nome del dispositivo
   - Copia il **TOKEN** generato

2. **Nel Print Agent**:
   - Incolla il Token
   - Inserisci un nome dispositivo (es. "Cassa 1")
   - Seleziona la stampante termica
   - Clicca "Salva e Connetti"

Il Company ID viene recuperato automaticamente dal server.

## Requisiti
- Node.js 18+
- Una stampante termica (es. XP-420B, XP-208P, Epson TM-T88)
