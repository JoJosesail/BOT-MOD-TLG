require('dotenv').config(); // Cargar variables de entorno desde el archivo .env
const TelegramBot = require('node-telegram-bot-api');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const cron = require('node-cron');

// Validación de seguridad: Verifica que el token exista antes de arrancar
if (!process.env.TELEGRAM_TOKEN) {
    console.error("❌ ERROR FATAL: No se encontró TELEGRAM_TOKEN en el archivo .env");
    process.exit(1);
}

// Conexión a la Base de Datos en la Nube
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Conectado exitosamente a MongoDB Atlas'))
    .catch(err => {
        console.error('🔴 Error conectando a MongoDB:', err.message);
        process.exit(1);
    });
// Inicialización del bot
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Base de datos temporal en memoria
// Estructura: { userId: { strikes: 0, escalon: 0 } }
const usuarios = {}; 

// Reinicio diario a la medianoche (Hora del servidor)
cron.schedule('0 0 * * *', () => {
    for (const userId in usuarios) {
        // Solo se reinician los strikes parciales, el escalón de penalidad es permanente
        usuarios[userId].strikes = 0;
    }
    console.log('🔄 Reinicio diario: Strikes parciales a 0, escalones mantenidos.');
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Ignorar mensajes enviados por otros bots o por el propio bot
    if (msg.from.is_bot) return;

    let infraccion = false;
    let motivo = '';
    const texto = msg.text || msg.caption || '';
    const nombreUsuario = msg.from.first_name || 'Usuario';

    // 1. Filtro: Mensajes reenviados
    if (msg.forward_date || msg.forward_origin) {
        infraccion = true; 
        motivo = 'Mensaje reenviado prohibido';
    }

    // 2. Filtro: Enlaces y dominios (incluye t.me)
    if (!infraccion && (texto.match(/https?:\/\//i) || texto.match(/t\.me\//i) || texto.match(/telegram\.me\//i))) {
        infraccion = true; 
        motivo = 'Uso de enlaces no permitidos';
    }

    // 3. Filtro: Menciones a otros grupos o usuarios (@)
    if (!infraccion && texto.match(/@\w+/)) {
        infraccion = true; 
        motivo = 'Menciones externas prohibidas';
    }

    // 4. Filtro: Códigos QR (Procesamiento visual con diagnóstico)
    if (!infraccion && msg.photo) {
        try {
            console.log('📸 Foto detectada, intentando descargar...');
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileLink = await bot.getFileLink(fileId);
            console.log('✅ Enlace obtenido:', fileLink);
            
            const image = await Jimp.read(fileLink);
            console.log('✅ Imagen procesada por Jimp. Tamaño:', image.bitmap.width, 'x', image.bitmap.height);
            
            const qr = jsQR(
                new Uint8ClampedArray(image.bitmap.data), 
                image.bitmap.width, 
                image.bitmap.height
            );
            
            if (qr) {
                console.log('🚨 QR ENCONTRADO:', qr.data);
                infraccion = true; 
                motivo = 'Código QR detectado en la imagen';
            } else {
                console.log('❌ No se encontró ningún QR legible en esta imagen.');
            }
        } catch (error) {
            console.error('⚠️ Error interno escaneando imagen:', error.message);
        }
    }

    // Ejecución de la penalidad
    if (infraccion) {
        // Eliminar el mensaje infractor silenciosamente
        bot.deleteMessage(chatId, msg.message_id).catch(err => {
            console.error('Error al borrar mensaje (Verifica los permisos de admin del bot):', err.message);
        });
        
        aplicarStrike(chatId, userId, nombreUsuario, motivo);
    }
});

function aplicarStrike(chatId, userId, nombre, motivo) {
    // Si el usuario es nuevo en el registro, se inicializa
    if (!usuarios[userId]) {
        usuarios[userId] = { strikes: 0, escalon: 0 };
    }
    
    let user = usuarios[userId];
    user.strikes++;

    if (user.strikes === 3) {
        user.escalon++;
        user.strikes = 0; // Reinicia strikes para contar hacia el próximo escalón

        let tiempoSilencio = 0;
        
        // Asignación de tiempo de castigo según el escalón
        if (user.escalon === 1) tiempoSilencio = 86400;       // 1 día en segundos
        if (user.escalon === 2) tiempoSilencio = 86400 * 3;   // 3 días en segundos

        if (user.escalon >= 3) {
            // Nivel 3 (9 strikes acumulados en total) = Expulsión
            bot.banChatMember(chatId, userId).catch(() => {});
            bot.sendMessage(chatId, `🚫 **${nombre}** ha sido expulsado permanentemente del grupo (Alcanzó el límite máximo de infracciones).`, { parse_mode: 'Markdown' });
        } else {
            // Silencio temporal
            const hasta = Math.floor(Date.now() / 1000) + tiempoSilencio;
            
            bot.restrictChatMember(chatId, userId, { 
                can_send_messages: false, 
                until_date: hasta 
            }).catch(err => console.error("Error al silenciar:", err.message));
            
            const diasTexto = user.escalon === 1 ? '1 día' : '3 días';
            bot.sendMessage(chatId, `⚠️ **${nombre}** ha sido silenciado por **${diasTexto}**.\n**Motivo:** ${motivo}.\nHas subido al **Escalón ${user.escalon}** de penalizaciones.`, { parse_mode: 'Markdown' });
        }
    } else {
        // Advertencia parcial
        bot.sendMessage(chatId, `⚠️ **Advertencia ${user.strikes}/3** para **${nombre}**.\n**Motivo:** ${motivo}.`, { parse_mode: 'Markdown' });
    }
}

console.log('✅ Moderador iniciado correctamente. Escaneando mensajes en el grupo...');