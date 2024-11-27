import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import axios from 'axios';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
let TWITCH_ACCESS_TOKEN = process.env.TWITCH_ACCESS_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const CHANNELS_FILE_PATH = '/config/channels.json';

// Load channels from file if exists
let TWITCH_CHANNEL_NAMES = [];
if (fs.existsSync(CHANNELS_FILE_PATH)) {
    TWITCH_CHANNEL_NAMES = JSON.parse(fs.readFileSync(CHANNELS_FILE_PATH, 'utf8'));
}

let liveStatus = {};

// Register slash commands
const commands = [
    {
        name: 'ping',
        description: 'Replies with Pong!',
    },
    {
        name: 'addchannel',
        description: 'Adds a Twitch channel to the list',
        options: [
            {
                name: 'channel',
                type: 3, // STRING type
                description: 'The name of the Twitch channel',
                required: true,
            },
        ],
    },
    {
        name: 'removechannel',
        description: 'Removes a Twitch channel from the list',
        options: [
            {
                name: 'channel',
                type: 3, // STRING type
                description: 'The name of the Twitch channel',
                required: true,
            },
        ],
    },
    {
        name: 'listchannels',
        description: 'Lists all Twitch channels',
    },
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();

async function validateTwitchToken() {
    try {
        // Validate current token
        const validateResponse = await axios.get('https://id.twitch.tv/oauth2/validate', {
            headers: {
                'Authorization': `Bearer ${TWITCH_ACCESS_TOKEN}`
            }
        });
        
        console.log('Twitch token is valid');
    } catch (error) {
        console.log('Token invalid or expired, refreshing...');
        
        try {
            // Get new token
            const tokenResponse = await axios.post(`https://id.twitch.tv/oauth2/token`, null, {
                params: {
                    client_id: TWITCH_CLIENT_ID,
                    client_secret: TWITCH_CLIENT_SECRET,
                    grant_type: 'client_credentials'
                }
            });

            TWITCH_ACCESS_TOKEN = tokenResponse.data.access_token;
            console.log('Successfully refreshed Twitch token');
        } catch (refreshError) {
            console.error('Failed to refresh Twitch token:', refreshError);
        }
    }
}

client.once('ready', () => {
    console.log('Ready!');

    // Initialize live status for each channel
    TWITCH_CHANNEL_NAMES.forEach(channel => {
        liveStatus[channel] = false;
    });

    // Initial token validation
    validateTwitchToken();

    // Set up periodic token validation (every hour)
    setInterval(validateTwitchToken, 3600000); // 3600000 ms = 1 hour

    // Check Twitch stream status every 60 seconds
    setInterval(checkTwitchStreams, 10000);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    if (commandName === 'ping') {
        await interaction.reply('Pong!');
    } else if (commandName === 'addchannel') {
        const channelName = options.getString('channel');
        if (!TWITCH_CHANNEL_NAMES.includes(channelName)) {
            TWITCH_CHANNEL_NAMES.push(channelName);
            saveChannels();
            liveStatus[channelName] = false;
            await interaction.reply(`Channel ${channelName} added.`);
        } else {
            await interaction.reply(`Channel ${channelName} is already in the list.`);
        }
    } else if (commandName === 'removechannel') {
        const channelName = options.getString('channel');
        const index = TWITCH_CHANNEL_NAMES.indexOf(channelName);
        if (index > -1) {
            TWITCH_CHANNEL_NAMES.splice(index, 1);
            saveChannels();
            delete liveStatus[channelName];
            await interaction.reply(`Channel ${channelName} removed.`);
        } else {
            await interaction.reply(`Channel ${channelName} not found in the list.`);
        }
    } else if (commandName === 'listchannels') {
        if (TWITCH_CHANNEL_NAMES.length > 0) {
            await interaction.reply(`Channels: ${TWITCH_CHANNEL_NAMES.join(', ')}`);
        } else {
            await interaction.reply('No channels in the list.');
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);

async function checkTwitchStreams() {
    try {
        if (TWITCH_CHANNEL_NAMES.length === 0) {
            return;
        }
        const userQueryParams = TWITCH_CHANNEL_NAMES.map(name => `login=${name}`).join('&');
        const usersResponse = await axios.get(`https://api.twitch.tv/helix/users?${userQueryParams}`, {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${TWITCH_ACCESS_TOKEN}`
            }
        });

        const userIds = usersResponse.data.data.map(user => user.id);
        const userNames = usersResponse.data.data.reduce((acc, user) => {
            acc[user.id] = user.display_name;
            return acc;
        }, {});

        const streamQueryParams = userIds.map(id => `user_id=${id}`).join('&');
        const streamsResponse = await axios.get(`https://api.twitch.tv/helix/streams?${streamQueryParams}`, {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${TWITCH_ACCESS_TOKEN}`
            }
        });

        const liveStreams = streamsResponse.data.data;

        for (const userId of userIds) {
            const stream = liveStreams.find(s => s.user_id === userId);
            if (stream && !liveStatus[userId]) {
                liveStatus[userId] = true;
                const gameResponse = await axios.get(`https://api.twitch.tv/helix/games`, {
                    headers: {
                        'Client-ID': TWITCH_CLIENT_ID,
                        'Authorization': `Bearer ${TWITCH_ACCESS_TOKEN}`
                    },
                    params: {
                        id: stream.game_id
                    }
                });

                const gameName = gameResponse.data.data[0].name;
                const broadcasterName = userNames[userId];

                sendDiscordMessage(`Twitch channel ${broadcasterName} is now live! They are playing ${gameName}. Watch here: https://www.twitch.tv/${stream.user_name}`);
            } else if (!stream && liveStatus[userId]) {
                liveStatus[userId] = false;
            }
        }
    } catch (error) {
        console.error(`Error fetching Twitch stream data:`, error);
    }
}

function sendDiscordMessage(message) {
    const channel = client.channels.cache.get(DISCORD_CHANNEL_ID);
    if (channel) {
        channel.send(message);
    } else {
        console.error('Channel not found');
    }
}

function saveChannels() {
    fs.writeFileSync(CHANNELS_FILE_PATH, JSON.stringify(TWITCH_CHANNEL_NAMES, null, 2));
}
