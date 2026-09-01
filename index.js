require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const cron = require('node-cron');
const mongoose = require('mongoose');

// Importamos el archivo que acabas de crear en la carpeta models
const Usuario = require('./models/Usuario');

if (!process.env.TELEGRAM_TOKEN || !process.env.MONGO_URI) {
    console.error("❌ ERROR FATAL: Faltan credenciales en el archivo .env");
    process.exit(1);
}

// Conexión a MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Conectado exitosamente a MongoDB Atlas'))
    .catch(err => {
        console.error('🔴 Error conectando a MongoDB:', err.message);
        process.exit(1);
    });

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Limpieza diaria
cron.schedule('0 0 * * *', async () => {
    try {
        await Usuario.updateMany({}, { $set: { strikes: 0 } });
        console.log('🔄 Reinicio diario en DB: Strikes parciales a 0.');
    } catch (error) {
        console.error('Error limpiando la base de datos:', error.message);
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (msg.from.is_bot) return;

    let infraccion = false;
    let motivo = '';
    const texto = msg.text || msg.caption || '';
    const nombreUsuario = msg.from.first_name || 'Usuario';

    if (msg.forward_date || msg.forward_origin) {
        infraccion = true; motivo = 'Mensaje reenviado prohibido';
    }

    if (!infraccion && (texto.match(/https?:\/\//i) || texto.match(/t\.me\//i) || texto.match(/telegram\.me\//i))) {
        infraccion = true; motivo = 'Uso de enlaces no permitidos';
    }

    if (!infraccion && texto.match(/@\w+/)) {
        infraccion = true; motivo = 'Menciones externas prohibidas';
    }

    if (!infraccion && msg.photo) {
        try {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileLink = await bot.getFileLink(fileId);
            
            const image = await Jimp.read(fileLink);
            const qr = jsQR(
                new Uint8ClampedArray(image.bitmap.data), 
                image.bitmap.width, 
                image.bitmap.height
            );
            
            if (qr) {
                infraccion = true; motivo = 'Código QR detectado';
            }
        } catch (error) {
            console.error('Error interno escaneando imagen:', error.message);
        }
    }

    if (infraccion) {
        bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        aplicarStrike(chatId, userId, nombreUsuario, motivo);
    }
});

async function aplicarStrike(chatId, userId, nombre, motivo) {
    try {
        let user = await Usuario.findOne({ userId: userId });
        
        if (!user) {
            user = new Usuario({
                userId: userId,
                nombre: nombre,
                strikes: 0,
                escalon: 0
            });
        }

        if (user.esVip) {
            bot.sendMessage(chatId, `✨ El mensaje de **${nombre}** fue eliminado por las reglas, pero posee inmunidad VIP.`, { parse_mode: 'Markdown' });
            return;
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
                
                bot.restrictChatMember(chatId, userId, { 
                    can_send_messages: false, 
                    until_date: hasta 
                }).catch(() => {});
                
                const diasTexto = user.escalon === 1 ? '1 día' : '3 días';
                bot.sendMessage(chatId, `⚠️ **${nombre}** silenciado por **${diasTexto}**.\n**Motivo:** ${motivo}.\nHas subido al **Escalón ${user.escalon}** de penalizaciones.`, { parse_mode: 'Markdown' });
            }
        } else {
            bot.sendMessage(chatId, `⚠️ **Advertencia ${user.strikes}/3** para **${nombre}**.\n**Motivo:** ${motivo}.`, { parse_mode: 'Markdown' });
        }

        await user.save();

    } catch (error) {
        console.error('Error de Base de Datos:', error.message);
    }
}