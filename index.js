require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const cron = require('node-cron');
const mongoose = require('mongoose');

const Usuario = require('./models/Usuario');
const ConfigGrupo = require('./models/ConfigGrupo');

if (!process.env.TELEGRAM_TOKEN || !process.env.MONGO_URI) {
    console.error("❌ ERROR FATAL: Faltan credenciales en el archivo .env");
    process.exit(1);
}

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Conectado exitosamente a MongoDB Atlas'))
    .catch(err => {
        console.error('🔴 Error conectando a MongoDB:', err.message);
        process.exit(1);
    });

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Tu ID de administrador global
const ADMINS_AUTORIZADOS = [798501790]; 

// Función para verificar si es admin en un chat específico
async function esAdmin(chatId, userId) {
    if (ADMINS_AUTORIZADOS.includes(userId)) return true;
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

cron.schedule('0 0 * * *', async () => {
    try {
        await Usuario.updateMany({}, { $set: { strikes: 0 } });
        console.log('🔄 Reinicio diario en DB: Strikes parciales a 0.');
    } catch (error) {
        console.error('Error limpiando la base de datos:', error.message);
    }
});

bot.onText(/\/myid/, (msg) => {
    if (msg.chat.type === 'private') {
        bot.sendMessage(msg.chat.id, `Tu ID de Telegram es: \`${msg.from.id}\``, { parse_mode: 'Markdown' });
    }
});

// --- COMANDO: Agregar link permitido (Funciona dentro del grupo) ---
bot.onText(/\/permitir (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const dominioNuevo = match[1].trim().toLowerCase();

    // Si se ejecuta en privado, no se puede saber a qué grupo aplicar sin especificarlo
    if (chatId > 0) {
        bot.sendMessage(chatId, "⚠️ Por favor, usa este comando **dentro del grupo** que deseas configurar.", { parse_mode: 'Markdown' });
        return;
    }

    if (!(await esAdmin(chatId, userId))) return;

    bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    try {
        let config = await ConfigGrupo.findOne({ chatId: chatId });
        if (!config) {
            config = new ConfigGrupo({ chatId: chatId, linksPermitidos: [] });
        }

        if (!config.linksPermitidos.includes(dominioNuevo)) {
            config.linksPermitidos.push(dominioNuevo);
            await config.save();
            bot.sendMessage(userId, `✅ **Dominio Autorizado:** \`${dominioNuevo}\` agregado a la lista blanca de este grupo.`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(userId, `ℹ️ El dominio \`${dominioNuevo}\` ya estaba autorizado.`, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.error('Error en /permitir:', error.message);
    }
});

// --- COMANDO: Ver links permitidos (Dentro del grupo) ---
bot.onText(/\/linkspermitidos/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (chatId > 0) {
        bot.sendMessage(chatId, "⚠️ Por favor, usa este comando **dentro del grupo** que deseas consultar.", { parse_mode: 'Markdown' });
        return;
    }

    if (!(await esAdmin(chatId, userId))) return;

    bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    try {
        const config = await ConfigGrupo.findOne({ chatId: chatId });
        
        if (!config || config.linksPermitidos.length === 0) {
            bot.sendMessage(userId, '📋 **Lista Blanca:** No hay dominios permitidos en este grupo.', { parse_mode: 'Markdown' });
            return;
        }

        let mensaje = '📋 **Dominios Permitidos en este Grupo:**\n\n';
        config.linksPermitidos.forEach((link, idx) => {
            mensaje += `${idx + 1}. \`${link}\`\n`;
        });

        bot.sendMessage(userId, mensaje, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error en /linkspermitidos:', error.message);
    }
});

// --- COMANDO DE AUDITORÍA: Infractores (Global o por Grupo) ---
bot.onText(/\/infractores/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Permitir auditoría global si es en privado, o en el grupo si es admin
    const esChatPrivado = chatId > 0;
    if (!esChatPrivado && !(await esAdmin(chatId, userId))) return;
    if (esChatPrivado && !ADMINS_AUTORIZADOS.includes(userId)) return;

    if (!esChatPrivado) {
        bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    }

    try {
        const infractores = await Usuario.find({ 
            $or: [{ strikes: { $gt: 0 } }, { escalon: { $gt: 0 } }] 
        }).sort({ escalon: -1, strikes: -1 });

        if (infractores.length === 0) {
            bot.sendMessage(userId, '✅ **Todo en orden.** No hay usuarios con penalizaciones registradas.', { parse_mode: 'Markdown' });
            return;
        }

        let mensaje = '📋 **Registro Confidencial de Infractores:**\n\n';
        infractores.forEach((user, index) => {
            if (index < 30) {
                mensaje += `👤 **${user.nombre}** (ID: \`${user.userId}\`)\n`;
                mensaje += `   ├ Strikes: ${user.strikes}/3 | Escalón: ${user.escalon}\n\n`;
            }
        });

        bot.sendMessage(userId, mensaje, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error en /infractores:', error.message);
    }
});

// --- COMANDO DE PERDÓN ---
bot.onText(/\/perdonar/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (chatId > 0) return;
    if (!(await esAdmin(chatId, userId))) return;

    bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    try {
        if (!msg.reply_to_message) {
            bot.sendMessage(userId, '⚠️ Error: Debes responder al mensaje del usuario con /perdonar.', { parse_mode: 'Markdown' });
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

// --- MODERADOR: Filtros Multi-Grupo ---
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
        // Busca la lista blanca específica del grupo actual donde ocurrió el mensaje
        const config = await ConfigGrupo.findOne({ chatId: chatId });
        let enlacePermitido = false;

        if (config && config.linksPermitidos && config.linksPermitidos.length > 0) {
            enlacePermitydo = config.linksPermitidos.some(dominio => texto.toLowerCase().includes(dominio));
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
            const image = `await` ? await Jimp.read(fileLink) : null; // Manteniendo sintaxis limpia
            const resolvedImage = await Jimp.read(fileLink);
            const qr = jsQR(new Uint8ClampedArray(resolvedImage.bitmap.data), resolvedImage.bitmap.width, resolvedImage.bitmap.height);
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