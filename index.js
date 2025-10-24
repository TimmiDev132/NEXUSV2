
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import {
  Client, GatewayIntentBits, Partials, REST, Routes,
  PermissionFlagsBits, ChannelType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} from 'discord.js';
import { log, warn, error } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helpers
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj) { try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch {} }

const DATA_DIR = path.join(__dirname,'..','data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const VERSION_FILE = path.join(DATA_DIR, 'last_version.json');

const env = process.env;
const CFG = {
  TOKEN: env.BOT_TOKEN,
  CLIENT_ID: env.CLIENT_ID,
  GUILD_ID: env.GUILD_ID,
  DEV_USER_ID: env.DEV_USER_ID,
  ANTISPAM_ENABLED: (env.ANTISPAM_ENABLED || 'true').toLowerCase() === 'true',
  BLOCK_LINKS: (env.BLOCK_LINKS || 'false').toLowerCase() === 'true',
  SERVER_NAME: env.SERVER_NAME || '',
  BRAND_COLOR: env.BRAND_COLOR || '',
  BANNER_URL: env.BANNER_URL || '',
  LOGO_URL: env.LOGO_URL || '',
  AUTO_EXIT_ON_FAIL: (env.AUTO_EXIT_ON_FAIL || 'false').toLowerCase() === 'true'
};

if (!CFG.TOKEN || !CFG.CLIENT_ID) { console.error("Missing BOT_TOKEN or CLIENT_ID"); process.exit(1); }

process.on('unhandledRejection', (reason) => { error('UnhandledRejection:', reason); if (CFG.AUTO_EXIT_ON_FAIL) process.exit(1); });
process.on('uncaughtException', (err) => { error('UncaughtException:', err); if (CFG.AUTO_EXIT_ON_FAIL) process.exit(1); });

// Keep-alive + Health
const app = express();
app.get('/', (_req, res) => res.send('NEXUS BOT V3.3.1 (Koyeb) running.'));
app.get('/health', (_req, res) => {
  try { res.json({ ok: true, uptime: process.uptime(), guilds: client.guilds?.cache?.size ?? 0 }); }
  catch { res.status(500).json({ ok: false }); }
});
app.listen(process.env.PORT || 3000, () => log('HTTP server ready on', process.env.PORT || 3000));

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Persistence
function loadUsers(){ return readJson(USERS_FILE, {}); }
function saveUsers(o){ writeJson(USERS_FILE, o); }
function loadConfig() {
  const cfg = readJson(CONFIG_FILE, {brand:{serverName:'NEXUS Community',color:'#00A3FF',bannerUrl:'',logoUrl:''},autopost:{enabled:true,channelId:'',types:['meme','quote','fact'],intervalMin:180,lastPost:0},level:{messageXp:5,cooldownSec:60,thresholds:[{level:5,roleName:'VIP'},{level:10,roleName:'Elite'}]},guildSetup:{}});
  if (CFG.SERVER_NAME) cfg.brand.serverName = CFG.SERVER_NAME;
  if (CFG.BRAND_COLOR) cfg.brand.color = CFG.BRAND_COLOR;
  if (CFG.BANNER_URL) cfg.brand.bannerUrl = CFG.BANNER_URL;
  if (CFG.LOGO_URL) cfg.brand.logoUrl = CFG.LOGO_URL;
  return cfg;
}
function saveConfig(o){ writeJson(CONFIG_FILE, o); }

// Auto Update Announce
function getPackageVersion() { try { return JSON.parse(fs.readFileSync(path.join(__dirname,'..','package.json'),'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } }
function parseChangelog(version) {
  try { const raw = fs.readFileSync(path.join(__dirname,'..','CHANGELOG.md'),'utf8'); const lines = raw.split('\n'); const idx = lines.findIndex(l => l.startsWith('## ') && l.includes(version)); if (idx === -1) return null; let out = []; for (let i=idx+1; i<lines.length; i++){ const l = lines[i]; if (l.startsWith('## ')) break; out.push(l);} return out.join('\n').trim(); } catch { return null; }
}
function readLastVersion(){ return readJson(VERSION_FILE, {lastAnnounced:'0.0.0'}); }
function writeLastVersion(v){ writeJson(VERSION_FILE, {lastAnnounced:v}); }
async function announceIfVersionChanged(guild){
  const last = readLastVersion(); const current = getPackageVersion(); if (last.lastAnnounced === current) return;
  let ch = guild.channels.cache.find(c=>c.type===0 && /updates|neuigkeiten|ankündigungen/i.test(c.name));
  if (!ch){ let cat = guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory && /info|📣/i.test(c.name)) || await guild.channels.create({ name:'📣 Info', type:ChannelType.GuildCategory }).catch(()=>null); ch = await guild.channels.create({ name:'updates', type:ChannelType.GuildText, parent:cat?.id }).catch(()=>null); }
  if (!ch) return;
  const body = parseChangelog(current) || 'Update ohne Changelog-Eintrag.';
  const emb = new EmbedBuilder().setTitle(`📢 Update ${current}`).setDescription(body).setTimestamp();
  await ch.send({ embeds: [emb] }).catch(()=>null);
  writeLastVersion(current);
}

// Branding
function buildWelcomeEmbed(cfg, guild) {
  const emb = new EmbedBuilder().setTitle(`Willkommen auf ${cfg.brand.serverName || guild.name}!`).setDescription('Lies die **rules**, hol dir **Rollen** (Buttons) und sag **Hi** in #chat.').setTimestamp();
  const color = parseInt((cfg.brand.color||'#00A3FF').replace('#',''),16); emb.setColor(isNaN(color)?0x00A3FF:color);
  if (cfg.brand.bannerUrl) emb.setImage(cfg.brand.bannerUrl);
  if (cfg.brand.logoUrl) emb.setThumbnail(cfg.brand.logoUrl);
  return emb;
}

// Auto-Setup
async function ensureServerSetup(guild){
  const cfg = loadConfig(); if (cfg.guildSetup[guild.id]?.done) return cfg;
  const everyone = guild.roles.everyone;
  const roleDefs = [
    { name:'DeveloperBot', hoist:true, perms:[PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ModerateMembers] },
    { name:'Staff', hoist:true, perms:[PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageChannels] },
    { name:'Moderator', hoist:false, perms:[PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers] },
    { name:'Supporter', hoist:false, perms:[] },
    { name:'Verified', hoist:false, perms:[] },
    { name:'Gaming', hoist:false, perms:[] },
    { name:'Music', hoist:false, perms:[] },
    { name:'Tech', hoist:false, perms:[] },
    { name:'VIP', hoist:false, perms:[] },
    { name:'Elite', hoist:false, perms:[] }
  ];
  const roles = {};
  for (const def of roleDefs){
    let role = guild.roles.cache.find(r=>r.name.toLowerCase()===def.name.toLowerCase());
    if (!role) role = await guild.roles.create({ name:def.name, hoist:def.hoist, permissions:def.perms }).catch(()=>null);
    roles[def.name] = role?.id || null;
  }
  const ensureCat = async (name, overwrites=[])=>{
    let cat = guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory && c.name.toLowerCase()===name.toLowerCase());
    if (!cat) cat = await guild.channels.create({ name, type:ChannelType.GuildCategory, permissionOverwrites:overwrites }).catch(()=>null);
    return cat;
  };
  const staffOverwrites = [
    { id: everyone.id, deny:[PermissionFlagsBits.ViewChannel] },
    ...(roles['DeveloperBot']?[{ id: roles['DeveloperBot'], allow:[PermissionFlagsBits.ViewChannel] }]:[]),
    ...(roles['Staff']?[{ id: roles['Staff'], allow:[PermissionFlagsBits.ViewChannel] }]:[]),
  ];
  const infoCat = await ensureCat('📣 Info');
  const commCat = await ensureCat('💬 Community');
  const supportCat = await ensureCat('🛠 Support');
  const starCat = await ensureCat('⭐ Highlights');
  const eventsCat = await ensureCat('🎉 Events');
  const talkCat = await ensureCat('🎙 Talk & Hangout');
  const ideasCat = await ensureCat('💡 Ideen & Feedback');
  const staffCat = await ensureCat('🧰 Staff', staffOverwrites);

  const createText = async (name, parent, topic='', overwrites=[])=>{
    let ch = guild.channels.cache.find(c=>c.type===ChannelType.GuildText && c.name.toLowerCase()===name.toLowerCase());
    if (!ch) ch = await guild.channels.create({ name, type:ChannelType.GuildText, parent:parent?.id, topic, permissionOverwrites:overwrites }).catch(()=>null);
    return ch;
  };
  const createVoice = async (name, parent, overwrites=[])=>{
    let ch = guild.channels.cache.find(c=>c.type===ChannelType.GuildVoice && c.name.toLowerCase()===name.toLowerCase());
    if (!ch) ch = await guild.channels.create({ name, type:ChannelType.GuildVoice, parent:parent?.id, permissionOverwrites:overwrites }).catch(()=>null);
    return ch;
  };

  const infoOver = [
    { id: guild.roles.everyone.id, allow:[PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny:[PermissionFlagsBits.SendMessages] },
    ...(roles['DeveloperBot']?[{ id: roles['DeveloperBot'], allow:[PermissionFlagsBits.SendMessages] }]:[]),
    ...(roles['Staff']?[{ id: roles['Staff'], allow:[PermissionFlagsBits.SendMessages] }]:[])
  ];
  const rules = await createText('rules', infoCat, 'Serverregeln', infoOver);
  const welcome = await createText('welcome', infoCat, 'Begrüßung & Rollen', infoOver);
  const updates = await createText('updates', infoCat, 'Server-Updates & Patchnotes', infoOver);
  const announcements = await createText('announcements', infoCat, 'Wichtige Ankündigungen', infoOver);

  const chat = await createText('chat', commCat, 'Allgemeiner Chat');
  await createText('media', commCat, 'Bilder & Clips');
  await createText('commands', commCat, 'Befehle & Bot');
  const ticketInfo = await createText('ticket', supportCat, 'Info & Ticket-Erstellung');
  const starboard = await createText('starboard', starCat, '⭐ Highlights der Community');
  await createText('giveaways', eventsCat, 'Giveaways & Events');
  const suggestions = await createText('suggestions', ideasCat, 'Vorschläge & Voting');

  await createVoice('voice-chat-1', talkCat);
  await createVoice('music-lounge', talkCat);
  await createVoice('gaming-squad', talkCat);
  await createVoice('chill-corner', talkCat);

  const modlog = await createText('modlog', staffCat, 'Moderations-Logs', staffOverwrites);
  await createText('staff-chat', staffCat, 'Team intern', staffOverwrites);
  await createText('transcripts', staffCat, 'Ticket-Transkripte', staffOverwrites);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rr_gaming').setLabel('Gaming').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('rr_music').setLabel('Music').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('rr_tech').setLabel('Tech').setStyle(ButtonStyle.Primary)
  );
  await (welcome || chat)?.send({ content: 'Hol dir Rollen:', components:[row] }).catch(()=>null);

  const brand = loadConfig().brand;
  const emb = new EmbedBuilder().setTitle(`Willkommen auf ${brand.serverName || guild.name}!`).setDescription('Lies die **rules**, hol dir **Rollen** (Buttons oben) und sag **Hi** in #chat.').setTimestamp();
  const color = parseInt((brand.color||'#00A3FF').replace('#',''),16); emb.setColor(isNaN(color)?0x00A3FF:color);
  if (brand.bannerUrl) emb.setImage(brand.bannerUrl);
  if (brand.logoUrl) emb.setThumbnail(brand.logoUrl);
  await welcome?.send({ embeds:[emb] }).catch(()=>null);

  const cfgGuild = cfg.guildSetup[guild.id] = { done:true, channels: { welcome: welcome?.id, updates: updates?.id, announcements: announcements?.id, chat: chat?.id, modlog: modlog?.id, starboard: starboard?.id, suggestions: suggestions?.id, ticketsInfo: ticketInfo?.id }, roles };
  if (cfg.autopost && !cfg.autopost.channelId && chat) cfg.autopost.channelId = chat.id;
  saveConfig(cfg);
  return cfg;
}

// Commands minimal
const commands = [
  { name: 'ping', description: 'Zeigt die Latenz an' },
  { name: 'help', description: 'Zeigt verfügbare Befehle an' },
  { name: 'ticket-open', description: 'Erstellt ein privates Ticket' },
  { name: 'ticket-close', description: 'Schließt das aktuelle Ticket' }
];
async function registerCommands(){
  const rest = new REST({version:'10'}).setToken(process.env.BOT_TOKEN);
  try {
    if (process.env.GUILD_ID) await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    else await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    log('Commands registriert.');
  } catch(e){ error('Command-Register:', e); }
}

// Systems
const xpCooldown = new Map();
const MEMES=['https://i.imgflip.com/30b1gx.jpg','https://i.imgflip.com/1bij.jpg','https://i.imgflip.com/2/26am.jpg'];
const QUOTES=['„Erfolg ist kein Ziel, sondern ein Weg.“','„Wer kämpft, kann verlieren. Wer nicht kämpft, hat schon verloren.“','„Stay humble, hustle hard.“'];
const FACTS=['Wusstest du? Honig verdirbt nie.','Fun Fact: In Japan gibt es KitKat mit grünem Tee.','Fun Fact: Ein Oktopus hat drei Herzen.'];
function calcLevel(xp){ return Math.floor(xp/100); }
async function autopostTick(client){
  const cfg = loadConfig(); const a = cfg.autopost; if (!a.enabled || !a.channelId) return;
  const now = Date.now(); const interval = Math.max(5, a.intervalMin||180)*60000; if (now - (a.lastPost||0) < interval) return;
  const ch = await client.channels.fetch(a.channelId).catch(()=>null); if (!ch) return;
  const types = a.types && a.types.length ? a.types : ['meme','quote','fact'];
  const pick = types[Math.floor(Math.random()*types.length)];
  let content=''; if (pick==='meme') content=MEMES[Math.floor(Math.random()*MEMES.length)];
  if (pick==='quote') content=QUOTES[Math.floor(Math.random()*QUOTES.length)];
  if (pick==='fact') content=`💡 ${FACTS[Math.floor(Math.random()*FACTS.length)]}`;
  if (content) await ch.send({ content }).catch(()=>null);
  a.lastPost = now; saveConfig(cfg);
}

// Events
client.once('ready', async () => {
  log(`Eingeloggt als ${client.user.tag}`);
  await registerCommands();
  for (const [,g] of client.guilds.cache) { await ensureServerSetup(g); await announceIfVersionChanged(g); }
  setInterval(()=>autopostTick(client), 60*1000);
});
client.on('guildCreate', async (guild) => { await ensureServerSetup(guild); });
client.on('guildMemberAdd', async (member) => {
  try {
    const cfg = loadConfig(); const gs = cfg.guildSetup[member.guild.id];
    const chId = gs?.channels?.welcome; const ch = chId ? await member.guild.channels.fetch(chId).catch(()=>null) : null;
    const emb = buildWelcomeEmbed(cfg, member.guild);
    ch?.send({ content:`Willkommen ${member}!`, embeds:[emb] });
    if (gs?.roles?.Verified) await member.roles.add(gs.roles.Verified).catch(()=>null);
    const modlogId = gs?.channels?.modlog; if (modlogId) { const ml = await member.guild.channels.fetch(modlogId).catch(()=>null); ml?.send(`🟢 **Join:** ${member.user.tag} (${member.id})`); }
  } catch (e) { warn('guildMemberAdd:', e.message); }
});
client.on('guildMemberRemove', async (member) => {
  try {
    const cfg = loadConfig(); const gs = cfg.guildSetup[member.guild.id];
    const modlogId = gs?.channels?.modlog; if (modlogId) { const ml = await member.guild.channels.fetch(modlogId).catch(()=>null); ml?.send(`🔴 **Leave:** ${member.user.tag} (${member.id})`); }
  } catch (e) { warn('guildMemberRemove:', e.message); }
});
client.on('messageCreate', async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;
    if ((process.env.ANTISPAM_ENABLED||'true').toLowerCase()==='true' && msg.content.length > 2000) { await msg.delete().catch(()=>null); return; }
    if ((process.env.BLOCK_LINKS||'false').toLowerCase()==='true' && /(https?:\/\/|discord\.gg\/)/i.test(msg.content)) { await msg.delete().catch(()=>null); }
    const key = `${msg.guild.id}:${msg.author.id}`; const cfg = loadConfig(); const last=xpCooldown.get(key)||0;
    if (Date.now()-last < (cfg.level.cooldownSec||60)*1000) return; xpCooldown.set(key,Date.now());
    const users = loadUsers(); const u = (users[msg.author.id] ??= { xp:0, coins:0, lastDaily:0, level:0 });
    u.xp += (cfg.level.messageXp||5); const lv = Math.floor(u.xp/100);
    if (lv > (u.level||0)) {
      u.level=lv; await msg.channel.send(`🎉 **Level Up!** ${msg.author} ist jetzt Level **${lv}**!`);
      for (const th of (cfg.level.thresholds||[])) { if (lv >= th.level) {
        let role = msg.guild.roles.cache.find(r=>r.name.toLowerCase()===th.roleName.toLowerCase());
        if (!role) role = await msg.guild.roles.create({ name: th.roleName, hoist:false }).catch(()=>null);
        if (role) await msg.member.roles.add(role).catch(()=>null);
      }}
    }
    writeJson(USERS_FILE, users);
  } catch (e) { warn('messageCreate:', e.message); }
});
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return; if (reaction.emoji.name !== '⭐') return;
    const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    const count = reaction.count ?? 0;
    const cfg = loadConfig(); const gs = cfg.guildSetup[msg.guild.id];
    const starId = gs?.channels?.starboard; if (!starId || count < 3) return;
    const starboardCh = await msg.guild.channels.fetch(starId).catch(()=>null); if (!starboardCh) return;
    const emb = new EmbedBuilder().setAuthor({ name: msg.author?.tag ?? 'Unbekannt' }).setDescription(msg.content || '(kein Text)').setFooter({ text:`#${msg.channel?.name} • ⭐ ${count} • ${msg.id}` }).setTimestamp(msg.createdTimestamp);
    if (msg.attachments?.size) { const first = msg.attachments.first(); if (first?.url) emb.setImage(first.url); }
    await starboardCh.send({ content:`⭐ **${count}** by ${user}`, embeds:[emb] });
  } catch (e) { warn('starboard:', e.message); }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, member, guild } = interaction;
  if (commandName === 'ping') {
    const sent = await interaction.reply({ content: 'Pong!', fetchReply: true });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(`Pong! Latenz: **${latency}ms**`); return;
  }
  if (commandName === 'help') {
    await interaction.reply({ content: 'NEXUS BOT ist aktiv ✅ — Tickets: **/ticket-open**. Rollen: Buttons im **#welcome**. Updates & AutoPost laufen automatisch.', ephemeral:true }); return;
  }
  if (commandName === 'ticket-open') {
    const cat = guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory && c.name.includes('Support'));
    if (!cat) return void interaction.reply({ content:'Support-Kategorie nicht gefunden.', ephemeral:true });
    const everyone = guild.roles.everyone;
    const channel = await guild.channels.create({
      name: `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g,''),
      type: ChannelType.GuildText,
      parent: cat.id,
      permissionOverwrites: [
        { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
      ],
      topic: `Ticket von ${interaction.user.tag}`
    });
    await interaction.reply({ content: `Ticket erstellt: ${channel}`, ephemeral: true });
    await channel.send(`Hallo ${interaction.user}, ein Teammitglied ist gleich da.`); return;
  }
  if (commandName === 'ticket-close') {
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) return void interaction.reply({ content:'Nur in Ticket-Kanälen nutzbar.', ephemeral:true });
    await interaction.reply({ content:'Ticket wird geschlossen…', ephemeral:true });
    setTimeout(()=>ch.delete().catch(()=>null), 3000); return;
  }
});

client.login(CFG.TOKEN);
