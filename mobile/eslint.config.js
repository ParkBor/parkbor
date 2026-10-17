const expoConfig = require('eslint-config-expo/flat');

module.exports = [{ ignores: ['dist/*', '.expo/*'] }, ...expoConfig];
