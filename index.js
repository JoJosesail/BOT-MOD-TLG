require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const cron = require('node-cron');
const mongoose = require('mongoose');

// Importamos los moldes de la base de datos
const Usuario = require('./models/Usuario');
const ConfigGrupo = require('./models/ConfigGrupo');

if (!process.env.TELEGRAM_TOKEN || !process.env.MONGO_URI) {
    console.error("❌ ERROR FATAL: Faltan credenciales en el archivo .env");
    process.exit(1);
}

// Conexión a MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Conectado exitosamente a MongoDB Atlas'))
    .catch(err => {
        console.error('🔴 Error conectando a MongoDB:', err.message);
        process.exit(1);
    });

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// --- LISTA DE ADMINISTRADORES AUTORIZADOS ---
// Puedes agregar más IDs separados por comas, ej: [798501790, 987654321]
const ADMINS_AUTORIZADOS = [798501790]; 

// Función auxiliar para verificar si un usuario es admin (por ID o por rol de Telegram)
async function esAdmin(chatId, userId) {
    if (ADMINS_AUTORIZADOS.includes(userId)) return true;
    
    // Si se ejecuta en un grupo, consultamos también los rangos oficiales de Telegram
    if (chatId < 0) {
        try {
            const admins = await bot.getChatAdministrators(chatId);
            return admins.some(admin => admin.user.id === userId);
        } catch (error) {
            return false;
        }
    }
    return false;
}

// --- MANTENIMIENTO: Limpieza masiva diaria de strikes ---
cron.schedule('0 0 * * *', async () => {
    try {
        await Usuario.updateMany({}, { $set: { strikes: 0 } });
        console.log('🔄 Reinicio diario en DB: Strikes parciales a 0.');
    } catch (error) {
        console.error('Error limpiando la base de datos:', error.message);
    }
});

// --- COMANDO RÁPIDO: Obtener ID propio en privado ---
bot.onText(/\/myid/, (msg) => {
    if (msg.chat.type === 'private') {
        bot.sendMessage(msg.chat.id, `Tu ID de Telegram es: \`${msg.from.id}\``, { parse_mode: 'Markdown' });
    }
});

// --- COMANDO: Agregar link permitido (Privado y Seguro) ---
bot.onText(/\/permitir (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const dominioNuevo = match[1].trim().toLowerCase();

    if (!(await esAdmin(chatId, userId))) return;

    // Si el comando se usó en el grupo, lo borramos para mantenerlo oculto
    if (msg.chat.type !== 'private') {
        bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    }

    try {
        // Nota: Si usas esto por privado, guardamos el dominio para el grupo principal o general. 
        // Aquí tomamos un chatId de referencia (idealmente tu grupo). Si estás en privado, puedes asignarlo a tu grupo principal.
        const targetChatId = msg.chat.type === 'private' ? ADMINS_AUTORIZADOS[0] : chatId; // O ajusta según tu grupo

        let config = await ConfigGrupo.findOne({ chatId: targetChatId });
        if (!config) {
            config = new ConfigGrupo({ chatId: targetChatId, linksPermitidos: [] });
        }

        if (!config.linksPermitidos.includes(dominioNuevo)) {
            config.linksPermitidos.push(dominioNuevo);
            await config.save();
            bot.sendMessage(userId, `✅ **Dominio Autorizado:** \`${dominioNuevo}\` agregado correctamente a la lista blanca.`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(userId, `ℹ️ El dominio \`${dominioNuevo}\` ya estaba en la lista permitida.`, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.error('Error en /permitir:', error.message);
    }
});

// --- COMANDO: Ver links permitidos (Envío Privado) ---
bot.onText(/\/linkspermitidos/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!(await esAdmin(chatId, userId))) return;

    if (msg.chat.type !== 'private') {
        bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    }

    try {
        const targetChatId = msg.chat.type === 'private' ? ADMINS_AUTORIZADOS[0] : chatId;
        const config = await ConfigGrupo.findOne({ chatId: targetChatId });
        
        if (!config || config.linksPermitidos.length === 0) {
            bot.sendMessage(userId, '📋 **Lista Blanca:** No hay dominios permitidos configurados.', { parse_mode: 'Markdown' });
            return;
        }

        let mensaje = '📋 **Dominios Permitidos:**\n\n';
        config.linksPermitidos.forEach((link, idx) => {
            mensaje += `${idx + 1}. \`${link}\`\n`;
        });

        bot.sendMessage(userId, mensaje, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error en /linkspermitidos:', error.message);
    }
});

// --- COMANDO DE AUDITORÍA: Infractores (Envío Privado) ---
bot.onText(/\/infractores/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!(await esAdmin(chatId, userId))) return;

    if (msg.chat.type !== 'private') {
        bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    }

    try {
        const infractores = await Usuario.find({ 
            $or: [{ strikes: { $gt: 0 } }, { escalon: { $gt: 0 } }] 
        }).sort({ escalon: -1, strikes: -1 });

        if (infractores.length === 0) {
            bot.sendMessage(userId, '✅ **El grupo está limpio.** No hay usuarios con penalizaciones.', { parse_mode: 'Markdown' });
            return;
        }

        let mensaje = '📋 **Registro Confidencial de Infractores:**\n\n';
        infractores.forEach((user, index) => {
            if (index < 30) {
                mensaje += `👤 **${user.nombre}** (ID: \`${user.userId}\`)\n`;
                mensaje += `   ├ Strikes: ${user.strikes}/3 | Escalón: ${user.escalon}\n\n`;
            }
        });

        // Se envía DIRECTAMENTE al chat privado del administrador para que nadie más lo vea
        bot.sendMessage(userId, mensaje, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error en /infractores:', error.message);
    }
});

// --- COMANDO DE PERDÓN (Privado y Seguro) ---
bot.onText(/\/perdonar/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!(await esAdmin(chatId, userId))) return;

    if (msg.chat.type !== 'private') {
        bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    }

    try {
        if (!msg.reply_to_message) {
            bot.sendMessage(userId, '⚠️ Error: Para perdonar a un usuario, debes usar el comando respondiendo a uno de sus mensajes.', { parse_mode: 'Markdown' });
            return;
        }

        const targetId = msg.reply_to_message.from.id;
        const targetNombre = msg.reply_to_message.from.first_name || 'Usuario';
        if (msg.reply_to_message.from.is_bot) return;

        let user = await Usuario.findOne({ userId: targetId });
        if (user && (user.strikes > 0 || user.escalon > 0)) {
            user.strikes = 0;
            user.escalon = 0;
            await user.save();
            bot.sendMessage(userId, `✅ **Historial Limpio.** Se absuelve a **${targetNombre}** de sus penalizaciones.`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(userId, `ℹ️ **${targetNombre}** no tiene penalizaciones registradas.`, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.error('Error en /perdonar:', error.message);
    }
});

// --- MODERADOR: Filtros de Cero Defectos ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (msg.from.is_bot) return;
    if (msg.chat.type === 'private') return; 

    let infraccion = false;
    let motivo = '';
    const texto = msg.text || msg.caption || '';
    const nombreUsuario = msg.from.first_name || 'Usuario';

    if (msg.forward_date || msg.forward_origin) {
        infraccion = true; motivo = 'Mensaje reenviado prohibido';
    }

    if (!infraccion && (texto.match(/https?:\/\//i) || texto.match(/t\.me\//i) || texto.match(/telegram\.me\//i))) {
        const config = await ConfigGrupo.findOne({ chatId: chatId });
        let enlacePermitido = false;

        if (config && config.linksPermitidos && config.linksPermitidos.length > 0) {
            enlacePermitido = config.linksPermitidos.some(dominio => texto.toLowerCase().includes(dominio));
        }

        if (!enlacePermitido) {
            infraccion = true;
            motivo = 'Uso de enlaces no permitidos';
        }
    }

    if (!infraccion && texto.match(/@\w+/)) {
        infraccion = true; motivo = 'Menciones externas prohibidas';
    }

    if (!infraccion && msg.photo) {
        try {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileLink = await bot.getFileLink(fileId);
            const image = await Jimp.read(fileLink);
            const qr = jsQR(new Uint8ClampedArray(image.bitmap.data), image.bitmap.width, image.bitmap.height);
            if (qr) { infraccion = true; motivo = 'Código QR detectado'; }
        } catch (error) {}
    }

    if (infraccion) {
        bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        aplicarStrike(chatId, userId, nombreUsuario, motivo);
    }
});

// --- PENALIZACIONES ---
async function aplicarStrike(chatId, userId, nombre, motivo) {
    try {
        let user = await Usuario.findOne({ userId: userId });
        if (!user) {
            user = new Usuario({ userId: userId, nombre: nombre, strikes: 0, escalon: 0 });
        }

        user.strikes++;

        if (user.strikes === 3) {
            user.escalon++;
            user.strikes = 0; 

            let tiempoSilencio = 0;
            if (user.escalon === 1) tiempoSilencio = 86400; 
            if (user.escalon === 2) tiempoSilencio = 86400 * 3; 

            if (user.escalon >= 3) {
                bot.banChatMember(chatId, userId).catch(() => {});
                bot.sendMessage(chatId, `🚫 **${nombre}** ha sido expulsado permanentemente del grupo.`, { parse_mode: 'Markdown' });
            } else {
                const hasta = Math.floor(Date.now() / 1000) + tiempoSilencio;
                bot.restrictChatMember(chatId, userId, { can_send_messages: false, until_date: hasta }).catch(() => {});
                bot.sendMessage(chatId, `⚠️ **${nombre}** silenciado por **${user.escalon === 1 ? '1 día' : '3 días'}**.\n**Motivo:** ${motivo}.\nHas subido al **Escalón ${user.escalon}**.`, { parse_mode: 'Markdown' });
            }
        } else {
            bot.sendMessage(chatId, `⚠️ **Advertencia ${user.strikes}/3** para **${nombre}**.\n**Motivo:** ${motivo}.`, { parse_mode: 'Markdown' });
        }

        await user.save();
    } catch (error) {
        console.error('Error de Base de Datos:', error.message);
    }
}