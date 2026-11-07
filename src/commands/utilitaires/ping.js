// @napi-rs/canvas est la dépendance canvas du projet (prebuilds, aucune
// compilation native requise) — le paquet « canvas » n'était utilisé que ici.
const { createCanvas } = require('@napi-rs/canvas');
const fetch = (...args) =>
  import("node-fetch").then(mod => mod.default(...args));
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');

/* -----------------------------------------------------
   🎨 PALETTE BLEU NÉON ASSORTIE AU LOGO
   ----------------------------------------------------- */

const C = {
    bg:         '#05060A',
    bg2:        '#0A0D14',

    card:       'rgba(10, 14, 22, 0.88)',
    card2:      'rgba(14, 18, 28, 0.92)',
    cardBorder: 'rgba(80, 140, 255, 0.20)',
    cardGlow:   'rgba(0, 120, 255, 0.18)',

    accent1:    '#4FB8FF',
    accent2:    '#2F7DFF',
    accent3:    '#6BE7FF',
    accent4:    '#1A4FFF',

    text:       '#EAF4FF',
    textSub:    '#A9C4E0',
    textMuted:  '#6F87A8',
    textDim:    '#3C4F66',

    good:       '#4FD2FF',
    goodGlow:   'rgba(79,210,255,0.30)',
    warn:       '#FFD24F',
    warnGlow:   'rgba(255,210,79,0.28)',
    bad:        '#FF4F7A',
    badGlow:    'rgba(255,79,122,0.28)',
};

/* -----------------------------------------------------
   🔧 FONCTIONS UTILITAIRES
   ----------------------------------------------------- */

function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
}

function hexToRgba(hex, alpha = 1) {
    const clean = hex.replace('#', '');
    const bigint = parseInt(clean, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r},${g},${b},${alpha})`;
}

/* -----------------------------------------------------
   🎨 DESSIN DES CARTES
   ----------------------------------------------------- */

function drawCard(ctx, x, y, w, h, r = 18, fill = C.card, border = C.cardBorder) {
    ctx.save();

    ctx.shadowColor = C.cardGlow;
    ctx.shadowBlur = 28;
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.shadowBlur = 0;

    const bg = ctx.createLinearGradient(x, y, x, y + h);
    bg.addColorStop(0, 'rgba(20,30,50,0.95)');
    bg.addColorStop(1, 'rgba(10,15,25,0.95)');
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = bg;
    ctx.fill();

    const gloss = ctx.createLinearGradient(x, y, x, y + h * 0.35);
    gloss.addColorStop(0, 'rgba(255,255,255,0.06)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    roundRect(ctx, x + 1, y + 1, w - 2, h * 0.42, r - 1);
    ctx.fillStyle = gloss;
    ctx.fill();

    const stroke = ctx.createLinearGradient(x, y, x + w, y + h);
    stroke.addColorStop(0, 'rgba(79,184,255,0.34)');
    stroke.addColorStop(0.5, 'rgba(47,125,255,0.22)');
    stroke.addColorStop(1, 'rgba(26,79,255,0.20)');
    roundRect(ctx, x, y, w, h, r);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    roundRect(ctx, x + 2, y + 2, w - 4, h - 4, r - 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
}

/* -----------------------------------------------------
   🎨 DIVIDER
   ----------------------------------------------------- */

function drawDivider(ctx, x1, y, x2) {
    const g = ctx.createLinearGradient(x1, y, x2, y);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(79,184,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.strokeStyle = g;
    ctx.lineWidth = 1;
    ctx.stroke();
}

/* -----------------------------------------------------
   📡 LATENCY
   ----------------------------------------------------- */

function latencyColor(ms) {
    if (ms < 120) return { color: C.good, glow: C.goodGlow };
    if (ms < 250) return { color: C.warn, glow: C.warnGlow };
    return { color: C.bad, glow: C.badGlow };
}

function latencyLabel(ms) {
    if (ms < 120) return { text: 'EXCELLENT', color: C.good };
    if (ms < 250) return { text: 'STABLE', color: C.warn };
    if (ms < 500) return { text: 'DEGRADED', color: C.warn };
    return { text: 'CRITICAL', color: C.bad };
}

/* -----------------------------------------------------
   🎛️ GAUGE
   ----------------------------------------------------- */

function drawGauge(ctx, cx, cy, radius, ms, maxMs = 1000) {
    const { color, glow } = latencyColor(ms);
    const DEG = Math.PI / 180;
    const startA = 160 * DEG;
    const sweep = 220 * DEG;
    const endA = startA + sweep;

    const fillFraction = Math.max(0, Math.min(ms / maxMs, 1));
    const fillEnd = startA + sweep * fillFraction;

    ctx.save();
    const aura = ctx.createRadialGradient(cx, cy, radius * 0.55, cx, cy, radius * 1.25);
    aura.addColorStop(0, 'rgba(0,0,0,0)');
    aura.addColorStop(1, hexToRgba(color, 0.07));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startA, endA);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    ctx.save();
    for (let i = 0; i <= 10; i++) {
        const a = startA + (sweep / 10) * i;
        const x1 = cx + Math.cos(a) * (radius - 19);
        const y1 = cy + Math.sin(a) * (radius - 19);
        const x2 = cx + Math.cos(a) * (radius - 29);
        const y2 = cy + Math.sin(a) * (radius - 29);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle =
            i / 10 <= fillFraction ? hexToRgba(color, 0.55) : 'rgba(255,255,255,0.07)';
        ctx.lineWidth = i % 5 === 0 ? 2 : 1.2;
        ctx.lineCap = 'butt';
        ctx.stroke();
    }
    ctx.restore();

    if (fillFraction > 0.005) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, startA, fillEnd);
        ctx.strokeStyle = glow;
        ctx.lineWidth = 26;
        ctx.lineCap = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = 20;
        ctx.stroke();
        ctx.restore();

        const arcGrad = ctx.createLinearGradient(
            cx - radius,
            cy - radius,
            cx + radius,
            cy + radius
        );
        arcGrad.addColorStop(0, C.accent3);
        arcGrad.addColorStop(0.45, C.accent2);
        arcGrad.addColorStop(1, color);

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, startA, fillEnd);
        ctx.strokeStyle = arcGrad;
        ctx.lineWidth = 14;
        ctx.lineCap = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
        ctx.stroke();
        ctx.restore();

        const ex = cx + Math.cos(fillEnd) * radius;
        const ey = cy + Math.sin(fillEnd) * radius;
        ctx.save();
        ctx.beginPath();
        ctx.arc(ex, ey, 6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 16;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ex, ey, 11, 0, Math.PI * 2);
        ctx.strokeStyle = hexToRgba(color, 0.25);
        ctx.lineWidth = 2;
        ctx.shadowBlur = 0;
        ctx.stroke();
        ctx.restore();
    }
}

/* -----------------------------------------------------
   🎖️ BADGE
   ----------------------------------------------------- */

function drawBadge(ctx, cx, y, label, color) {
    ctx.save();
    ctx.font = 'bold 12px sans-serif';
    const tw = ctx.measureText(label).width;
    const bw = tw + 36;
    const bh = 28;
    const bx = cx - bw / 2;

    roundRect(ctx, bx, y, bw, bh, 999);
    ctx.fillStyle = hexToRgba(color, 0.13);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(color, 0.4);
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, y + bh / 2);
    ctx.restore();
}

/* -----------------------------------------------------
   📊 GAUGE CARD
   ----------------------------------------------------- */

function drawGaugeCard(ctx, x, y, w, h, title, ms, subtitle) {
    drawCard(ctx, x, y, w, h, 22);

    const cx = x + w / 2;

    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = C.textMuted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(title.toUpperCase(), cx, y + 28);
    ctx.restore();

    const lineW = 72;
    const lineG = ctx.createLinearGradient(cx - lineW / 2, 0, cx + lineW / 2, 0);
    lineG.addColorStop(0, C.accent1);
    lineG.addColorStop(1, C.accent2);
    ctx.beginPath();
    ctx.moveTo(cx - lineW / 2, y + 36);
    ctx.lineTo(cx + lineW / 2, y + 36);
    ctx.strokeStyle = lineG;
    ctx.lineWidth = 2;
    ctx.stroke();

    const gaugeY = y + 52 + 76;
    drawGauge(ctx, cx, gaugeY, 76, ms);

    const { color } = latencyColor(ms);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.font = `bold ${ms >= 1000 ? 34 : 42}px sans-serif`;
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${ms}`, cx, gaugeY + 14);
    ctx.restore();

    ctx.save();
    ctx.font = '13px sans-serif';
    ctx.fillStyle = C.textSub;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('ms', cx, gaugeY + 34);
    ctx.restore();

    const lbl = latencyLabel(ms);
    drawBadge(ctx, cx, y + h - 62, lbl.text, lbl.color);

    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.fillStyle = C.textDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(subtitle, cx, y + h - 22);
    ctx.restore();
}

/* -----------------------------------------------------
   🛰️ CENTER PANEL
   ----------------------------------------------------- */

function drawCenterPanel(ctx, x, y, w, h, apiMs, botMs, wsConnected, uptime, sq) {
    drawCard(ctx, x, y, w, h, 22);

    const cx = x + w / 2;
    const avg = Math.round((apiMs + botMs) / 2);
    const { color: avgColor } = latencyColor(avg);

    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = C.textMuted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('NETWORK HEALTH', cx, y + 30);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, y + 82, 46, 0, Math.PI * 2);
    const ring = ctx.createLinearGradient(cx - 40, y + 40, cx + 40, y + 120);
    ring.addColorStop(0, hexToRgba(C.accent3, 0.5));
    ring.addColorStop(1, hexToRgba(avgColor, 0.3));
    ctx.strokeStyle = ring;
    ctx.lineWidth = 2;
    ctx.shadowColor = avgColor;
    ctx.shadowBlur = 20;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.shadowColor = avgColor;
    ctx.shadowBlur = 24;
    ctx.font = 'bold 52px sans-serif';
    ctx.fillStyle = avgColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${avg}`, cx, y + 100);
    ctx.restore();

    ctx.save();
    ctx.font = '13px sans-serif';
    ctx.fillStyle = C.textSub;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('average ms', cx, y + 120);
    ctx.restore();

    drawDivider(ctx, x + 24, y + 136, x + w - 24);

    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = C.textMuted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('WEBSOCKET STATUS', cx, y + 158);
    ctx.restore();

    const wsColor = wsConnected ? C.good : C.bad;
    const wsLabel = wsConnected ? 'CONNECTED' : 'DISCONNECTED';

    ctx.save();
    ctx.font = 'bold 14px sans-serif';
    const wsTextW = ctx.measureText(wsLabel).width;
    const dotR = 5;
    const gap = 8;
    const totalW = dotR * 2 + gap + wsTextW;
    const dotCX = cx - totalW / 2 + dotR;
    const labelX = cx - totalW / 2 + dotR * 2 + gap;
    const rowY = y + 178;

    ctx.beginPath();
    ctx.arc(dotCX, rowY - 4, dotR, 0, Math.PI * 2);
    ctx.fillStyle = wsColor;
    ctx.shadowColor = wsColor;
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = wsColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(wsLabel, labelX, rowY);
    ctx.restore();

    drawDivider(ctx, x + 24, y + 196, x + w - 24);

    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = C.textMuted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('SIGNAL QUALITY', cx, y + 216);
    ctx.restore();

    const barX = x + 24;
	

    ctx.save();
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${sq}%`, cx, y + 262);
    ctx.restore();

    drawDivider(ctx, x + 24, y + 273, x + w - 24);
}

function drawStarfield(ctx, W, H) {
    for (let i = 0; i < 60; i++) {
        const sx = (i * 157) % W;
        const sy = (i * 91) % H;
        const sr = i % 3 === 0 ? 1.4 : 0.8;
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fillStyle = i % 5 === 0
            ? 'rgba(255,255,255,0.18)'
            : 'rgba(180,160,255,0.10)';
        ctx.fill();
    }
}

function generateCanvasBuffer(client, apiMs, botMs) {
    const wsConnected = client.ws.status === 0;
    const uptime = client.uptime || 0;
    const sq = Math.max(0, Math.min(100, Math.round(100 - apiMs / 8)));

    const W = 980, H = 470;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#05060A');
    bg.addColorStop(0.45, '#0A0D14');
    bg.addColorStop(1, '#040508');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    [
        [150, 80, 240, 'rgba(79,184,255,0.12)'],
        [W - 130, 90, 260, 'rgba(47,125,255,0.12)'],
        [W / 2, H + 40, 280, 'rgba(26,79,255,0.08)'],
    ].forEach(([gx, gy, gr, gc]) => {
        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
        g.addColorStop(0, gc);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
    });

    ctx.strokeStyle = 'rgba(47,125,255,0.05)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < W; gx += 48) {
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, H);
        ctx.stroke();
    }
    for (let gy = 0; gy < H; gy += 48) {
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(W, gy);
        ctx.stroke();
    }

    drawStarfield(ctx, W, H);

    ctx.save();
    const border = ctx.createLinearGradient(0, 0, W, H);
    border.addColorStop(0, 'rgba(79,184,255,0.55)');
    border.addColorStop(0.5, 'rgba(47,125,255,0.40)');
    border.addColorStop(1, 'rgba(26,79,255,0.30)');
    roundRect(ctx, 3, 3, W - 6, H - 6, 24);
    ctx.strokeStyle = border;
    ctx.lineWidth = 2;
    ctx.shadowColor = C.accent1;
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.restore();

    const lx = W / 2, ly = 48, lr = 30;

    ctx.save();
    const logoRing = ctx.createLinearGradient(lx - lr, ly - lr, lx + lr, ly + lr);
    logoRing.addColorStop(0, C.accent1);
    logoRing.addColorStop(0.5, C.accent3);
    logoRing.addColorStop(1, C.accent2);
    ctx.beginPath();
    ctx.arc(lx, ly, lr + 4, 0, Math.PI * 2);
    ctx.strokeStyle = logoRing;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = C.accent3;
    ctx.shadowBlur = 16;
    ctx.stroke();
    ctx.restore();

    const moonBg = ctx.createRadialGradient(lx - 6, ly - 8, 2, lx, ly, lr + 8);
    moonBg.addColorStop(0, '#1E1430');
    moonBg.addColorStop(1, '#0D0B14');
    ctx.beginPath();
    ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    ctx.fillStyle = moonBg;
    ctx.fill();

    [[lx - 38, ly - 14, 2.2], [lx + 34, ly - 18, 1.8], [lx + 26, ly + 24, 1.5]].forEach(
        ([sx, sy, sr]) => {
            ctx.beginPath();
            ctx.arc(sx, sy, sr, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.shadowColor = '#fff';
            ctx.shadowBlur = 10;
            ctx.fill();
            ctx.shadowBlur = 0;
        }
    );

    ctx.save();
    ctx.fillStyle = C.accent3;
    ctx.shadowColor = C.accent3;
    ctx.shadowBlur = 10;

    ctx.beginPath();
    ctx.arc(lx, ly, 13, 0, Math.PI * 2, false);
    ctx.arc(lx + 7, ly - 4, 10, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.restore();

    ctx.save();
    const titleGrad = ctx.createLinearGradient(lx - 60, 0, lx + 60, 0);
    titleGrad.addColorStop(0, C.accent3);
    titleGrad.addColorStop(0.5, '#D8F2FF');
    titleGrad.addColorStop(1, C.accent2);
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = titleGrad;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
        ctx.fillText('REZO', lx, ly + 52);
    ctx.restore();

    ctx.save();
    ctx.font = '11px sans-serif';
    ctx.fillStyle = C.textMuted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('NETWORK STATUS MONITOR', lx, ly + 70);
    ctx.restore();

    const cardY = 136, cardH = 274;
    const gaugeW = 258;
    const centerW = W - gaugeW * 2 - 60;
    const gL = 20;
    const gC = gL + gaugeW + 10;
    const gR = gC + centerW + 10;

    drawGaugeCard(ctx, gL, cardY, gaugeW, cardH, 'API Latency', apiMs, 'Discord Gateway');
    drawCenterPanel(ctx, gC, cardY, centerW, cardH, apiMs, botMs, wsConnected, uptime, sq);
    drawGaugeCard(ctx, gR, cardY, gaugeW, cardH, 'Bot Latency', botMs, 'Message Roundtrip');

    const footY = cardY + cardH + 12;
    drawCard(ctx, 20, footY, W - 40, 34, 12, 'rgba(10,14,22,0.92)', '#0F1628');

    const uh = Math.floor(uptime / 3_600_000);
    const um = Math.floor((uptime % 3_600_000) / 60_000);

    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = C.textMuted;
    ctx.textBaseline = 'middle';
    const footMid = footY + 17;

    ctx.textAlign = 'left';
    ctx.fillText(`UPTIME  ${uh}h ${um}m`, 40, footMid);

    ctx.textAlign = 'center';
    ctx.fillText('REZO  •  realtime diagnostics', W / 2, footMid);

    ctx.textAlign = 'right';
    const now = new Date();
    const dateStr =
        now.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
        }) +
        '  ' +
        now.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
        });
    ctx.fillText(dateStr, W - 40, footMid);
    ctx.restore();

    return canvas.toBuffer('image/png');
}

/* -----------------------------------------------------
   🚀 SLASH COMMAND HANDLER
   ----------------------------------------------------- */

async function handlePingSlash(interaction) {
    try {
        const client = interaction.client;

        const before = Date.now();
        await interaction.deferReply();

        const botMs = Math.max(1, Date.now() - before);
        const apiMs = Math.max(1, Math.round(client.ws.ping));

        const buffer = generateCanvasBuffer(client, apiMs, botMs);
        const attachment = new AttachmentBuilder(buffer, { name: 'ping.png' });

        await interaction.editReply({ files: [attachment] });
    } catch (err) {
        console.error('❌ Ping slash command error:', err);

        if (interaction.deferred) {
            await interaction.editReply({
                content: `Couldn't fetch ping right now — try again! 💙`,
            }).catch(() => {});
        } else {
            await interaction.reply({
                content: `Couldn't fetch ping right now — try again! 💙`,
                ephemeral: true,
            }).catch(() => {});
        }
    }
}

/* -----------------------------------------------------
   📡 EXPORT SLASH COMMAND
   ----------------------------------------------------- */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('📡 Affiche un diagnostic réseau avancé'),

    async execute(interaction) {
        await handlePingSlash(interaction);
    },
};
