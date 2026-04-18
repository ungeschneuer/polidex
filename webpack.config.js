const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = (env, argv) => {
  const browser = env?.browser ?? 'chrome';
  if (!['chrome', 'firefox'].includes(browser)) {
    throw new Error(`Unknown browser: ${browser}. Use --env browser=chrome or --env browser=firefox`);
  }
  return {
    entry: {
      background: './src/background/index.ts',
      content: './src/content/index.ts',
      popup: './src/popup/popup.ts',
      welcome: './src/welcome/welcome.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist', browser),
      filename: '[name].js',
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: [MiniCssExtractPlugin.loader, 'css-loader'],
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js'],
      // Allow TypeScript files to be imported with .js extension (ESM style)
      extensionAlias: {
        '.js': ['.ts', '.js'],
      },
    },
    plugins: [
      new webpack.DefinePlugin({
        __POLIDEX_SERVER_URL__: JSON.stringify(process.env.POLIDEX_SERVER_URL ?? 'https://ungeschneuer.github.io/polidex'),
      }),
      new MiniCssExtractPlugin({ filename: '[name].css' }),
      new CopyPlugin({
        patterns: [
          { from: 'src/popup/popup.html', to: 'popup.html' },
          { from: 'src/welcome/welcome.html', to: 'welcome.html' },
          { from: `manifest.${browser}.json`, to: 'manifest.json' },
          { from: 'src/assets', to: 'assets', noErrorOnMissing: true },
          { from: 'server/data/politicians.json', to: 'politicians.json', noErrorOnMissing: true },
        ],
      }),
    ],
    devtool: argv.mode === 'development' ? 'inline-source-map' : false,
  };
};
