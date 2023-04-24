const fs = require('fs');
const path = require('path');
const EventEmitter = require('events').EventEmitter;

const lockfilePath = path.join(process.env['LOCALAPPDATA'], 'Riot Games\\League of Legends\\lockfile');

async function getLockfileData()
{
    const contents = await fs.promises.readFile(lockfilePath, 'utf8');
    let d = {};
    [d.name, d.pid, d.port, d.password, d.protocol] = contents.split(':');
    return d;
}

class LocalInfoProvider extends EventEmitter
{
    constructor()
    {
        super();
        this.lockFileData = null;
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
            this.lockFileData = await getLockfileData();
        }
        catch(e)
        {
            this.lockFileData = null;
        }
    
    close()
    {
        this.watcher.close();
    }
}
}

module.exports = LocalInfoProvider;