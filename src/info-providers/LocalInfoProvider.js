const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const https = require('https');
const EventEmitter = require('events').EventEmitter;
const logParser = require('../logParser');
const WebSocket = require('ws');

const localAgent = new https.Agent({
    rejectUnauthorized: false
});
const lockfilePath = path.join(process.env['LOCALAPPDATA'], 'Riot Games\\Riot Client\\Config\\lockfile');
const regions = ['na','ko','eu','ap'];
const partyPrefix = '/riot-messaging-service/v1/message/ares-parties/parties/v1/parties/';
const matchPrePrefix = '/riot-messaging-service/v1/message/ares-pregame/pregame/v1/matches/';

async function getLockfileData()
{
    const contents = await fs.promises.readFile(lockfilePath, 'utf8');
    let d = {};
    [d.name, d.pid, d.port, d.password, d.protocol] = contents.split(':');
    return d;
}

async function getLocalAPI(port, password, path)
{
    return (await fetch(`https://127.0.0.1:${port}/${path}`, {
        headers: {
            'Authorization': 'Basic ' + Buffer.from(`riot:${password}`).toString('base64')
        },
        agent: localAgent
    })).json();
}

async function getMatchID(port, password, status, region, puuid)
{
    // Get auth data
    const authData = await getLocalAPI(port, password, 'entitlements/v1/token');
    
    // Get player data
    const playerData = await (await fetch(`https://glz-${region}-1.${region}.a.pvp.net/${status === 'PREGAME' ? 'pregame' : 'core-game'}/v1/players/${puuid}`, {
        headers: {
            'Authorization': 'Bearer ' + authData['accessToken'],
            'X-Riot-Entitlements-JWT': authData['token'],
            'User-Agent': ''
        },
        agent: localAgent
    })).json();
    return playerData['MatchID'];
}

async function asyncTimeout(delay)
{
    return new Promise(resolve =>
    {
        setTimeout(resolve, delay);
    });
}

async function waitForExternalSession(port, password)
{
    let data = {};
    while(true)
    {
        data = await getLocalAPI(port, password, 'product-session/v1/external-sessions');
        if(Object.keys(data).length === 0)
        {
            await asyncTimeout(1000);
        }
        else
        {
            break;
        }
    }
    return data;
}

async function loadLocalData(port, password, retryCount = 0, delay = 1500)
{
    for(let tries = 0; retryCount === -1 || tries <= retryCount; tries++)
    {
        try
        {
            const sessionData = await getLocalAPI(port, password, 'chat/v1/session');
            const externalSessions = await waitForExternalSession(port, password);
            
            return {
                sessionData,
                externalSessions
            };
        }
        catch(e)
        {
            if(retryCount === -1 || tries < retryCount)
            {
                await asyncTimeout(delay);
            }
        }
    }
    throw new Error('Retry limit reached');
}

async function waitForPrivatePresence(port, password, puuid, retryCount = -1, delay = 1500)
{
    for(let tries = 0; retryCount === -1 || tries <= retryCount; tries++)
    {
        try
        {
            const presenceData = await getLocalAPI(port, password, 'chat/v4/presences');
            return JSON.parse(Buffer.from(presenceData.presences.find(p => p.puuid === puuid).private, 'base64').toString());
        }
        catch(e)
        {
            if(retryCount === -1 || tries < retryCount)
            {
                await asyncTimeout(delay);
            }
        }
    }
    throw new Error('Retry limit reached');
}

function getRegionFromSessions(sessions)
{
    const sessionKeys = Object.keys(sessions);
    const argStart = '-ares-deployment=';
    for(const arg of sessions[sessionKeys[0]].launchConfiguration.arguments)
    {
        if(arg.startsWith(argStart))
        {
            return arg.substring(argStart.length);
        }
    }
    return null;
}

class LocalInfoProvider extends EventEmitter
{
    constructor()
    {
        super();
        this.lockFileData = null;
        this.localData = null;
        this.clientVersion = null;
        this.region = null;
        this.matchID = null;
        this.matchState = null;
        this.partyID = null;
        
        this.ws = null;
        
        this.watcher = fs.watch(path.dirname(lockfilePath), async (eventType, fileName) =>
        {
            if(eventType === 'rename' && fileName === 'lockfile')
            {
                await this.tryUpdateInfo();
            }
        });
        this.tryUpdateInfo();
    }
    
    async tryUpdateInfo()
    {
        try
        {
            // Load lockfile data and local api endpoint (for region)
            this.lockFileData = await getLockfileData();
            this.localData = await loadLocalData(this.lockFileData.port, this.lockFileData.password);
            this.region = getRegionFromSessions(this.localData.externalSessions);
            
            // Get party status and match status
            const privatePresenceData = await waitForPrivatePresence(this.lockFileData.port, this.lockFileData.password, this.localData.sessionData['puuid']);
            console.log(privatePresenceData);
            
            this.partyID = privatePresenceData['partyId'];
            this.matchState = privatePresenceData['sessionLoopState'];
            
            // If a match is currently happening, get the match id
            if(['INGAME', 'PREGAME'].includes(this.matchState))
            {
                console.log('Grabbing match id!');
                this.matchID = await getMatchID(this.lockFileData.port, this.lockFileData.password, this.matchState, this.region, this.localData.sessionData['puuid']);
                console.log('Match id:');
                console.log(this.matchID);
            }
            
            // Load the websocket to listen for party changes / matches starting and stopping
            if(this.ws !== null && this.ws.readyState < 2)
            {
                this.ws.close();
            }
            this.ws = new WebSocket(`wss://riot:${this.lockFileData.password}@localhost:${this.lockFileData.port}`, {
                rejectUnauthorized: false
            });
            this.ws.on('open', () =>
            {
                this.ws.send(JSON.stringify([5, 'OnJsonApiEvent_riot-messaging-service_v1_message']));
                this.ws.send(JSON.stringify([5, 'OnJsonApiEvent_chat_v4_presences']));
            });
            this.ws.on('message', dataStr =>
            {
                if(dataStr.length === 0) return;
    
                const eventData = JSON.parse(dataStr);
                const data = eventData[2];
                if(eventData[1] === 'OnJsonApiEvent_riot-messaging-service_v1_message')
                {
                    if(data.uri.startsWith(matchPrePrefix))
                    {
                        this.matchID = data.uri.substring(matchPrePrefix.length);
                    }
                    else if(data.uri.startsWith(partyPrefix))
                    {
                        this.partyID = data.uri.substring(partyPrefix.length);
                    }
                }
                else if(eventData[1] === 'OnJsonApiEvent_chat_v4_presences')
                {
                    const presence = data.data['presences'][0];
                    if(presence.puuid !== this.localData.sessionData['puuid']) return;
                    const privateData = JSON.parse(Buffer.from(presence['private'], 'base64').toString());
                    
                    this.matchState = privateData['sessionLoopState'];
                    if(this.matchState === 'MENUS')
                    {
                        console.log('Clearing match id');
                        this.matchID = null;
                    }
                }
            });
            
            this.emit('update');
        }
        catch(e)
        {
            console.error(e);
            this.lockFileData = null;
            this.localData = null;
        }
    }
    
    async refreshClientVersion()
    {
        try
        {
            // First try reading log
            this.clientVersion = await logParser.getClientVersion();
        }
        catch(ignored)
        {
            // Next, try the unofficial api
            const apiData = await (await fetch('https://valorant-api.com/v1/version')).json();
            this.clientVersion = apiData.data['riotClientVersion'];
        }
        return this.clientVersion;
    }
    
    async getClientVersion()
    {
        if(this.clientVersion === null)
        {
            await this.refreshClientVersion();
        }
        return this.clientVersion;
    }
    
    async manuallySetRegion(context)
    {
        const region = (await context.app.prompt('Enter Valorant Region', {
            label: `Must be one of [${regions.join(' | ')}]`
        })).toLowerCase();
        if(!regions.includes(region))
        {
            throw new Error('Invalid region');
        }
        
        this.region = region;
        await context.store.setItem('region', this.region);
    }
    
    async getRegion(context)
    {
        if(this.region === null)
        {
            // Check if there's a saved version
            if(await context.store.hasItem('region'))
            {
                this.region = await context.store.getItem('region');
            }
            else
            {
                // Check if region is in startup params
                if(this.localData !== null)
                {
                    this.region = getRegionFromSessions(this.localData.externalSessions);
                    await context.store.setItem('region', this.region);
                }
                else
                {
                    // Try reading region from log
                    try
                    {
                        this.region = await logParser.getRegion();
                        await context.store.setItem('region', this.region);
                    }
                    catch(ignored)
                    {
                        // Finally, just ask the user for a region
                        // This seems to only work when sending a request
                        await this.manuallySetRegion(context);
                    }
                }
            }
        }
        return this.region;
    }
    
    close()
    {
        this.watcher.close();
    }
}

module.exports = LocalInfoProvider;
