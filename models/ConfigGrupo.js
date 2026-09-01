const mongoose = require('mongoose');

const configGrupoSchema = new mongoose.Schema({
    chatId: { type: Number, required: true, unique: true },
    linksPermitidos: { type: [String], default: [] } // Lista de dominios (ej. youtube.com, github.com)
});

module.exports = mongoose.model('ConfigGrupo', configGrupoSchema);