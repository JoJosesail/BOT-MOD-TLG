const mongoose = require('mongoose');

const usuarioSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    nombre: { type: String, required: true },
    // Sistema de Moderación
    strikes: { type: Number, default: 0 },
    escalon: { type: Number, default: 0 },
    // Sistema de Referidos
    referidoPor: { type: Number, default: null }, // ID de quien lo invitó
    totalReferidos: { type: Number, default: 0 },
    // Sistema de Membresía
    suscripcionActiva: { type: Boolean, default: false },
    fechaVencimiento: { type: Date, default: null },
    esVip: { type: Boolean, default: false } // Para darle inmunidad a strikes si lo deseas
});

module.exports = mongoose.model('Usuario', usuarioSchema);