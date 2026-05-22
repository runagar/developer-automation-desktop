const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');

module.exports = {
  entry: './src/main/index.ts',
  module: {
    rules: [
      {
        test: /\.node$/,
        use: 'node-loader',
      },
      {
        test: /\.tsx?$/,
        exclude: /(node_modules|\.webpack)/,
        use: {
          loader: 'ts-loader',
          options: { transpileOnly: true },
        },
      },
    ],
  },
  plugins: [
    new ForkTsCheckerWebpackPlugin({ logger: 'webpack-infrastructure' }),
  ],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
  externals: {
    'better-sqlite3': 'commonjs better-sqlite3',
    'node-pty': 'commonjs node-pty',
  },
};
