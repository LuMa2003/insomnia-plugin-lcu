const LocalInfoProvider = require('./info-providers/LocalInfoProvider');

const localInfoProvider = new LocalInfoProvider();

function getLockfileDataElement(name)
{
    if(localInfoProvider.lockFileData === null)
    {
        throw new Error('No lockfile found! Is League running?');
    }
    return localInfoProvider.lockFileData[name];
}

function generateLockfileTag(displayName, property)
{
    return {
        name: 'lockfile' + property,
        displayName: 'Lockfile ' + displayName,
        description: 'League Lockfile ' + displayName,
        async run()
        {
            return getLockfileDataElement(property);
        }
    }
}

module.exports.templateTags = [
    generateLockfileTag('Port', 'port'),
    generateLockfileTag('Password', 'password'),
    generateLockfileTag('Protocol', 'protocol'),
];