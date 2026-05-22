const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');

module.exports = {
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
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new ForkTsCheckerWebpackPlugin({ logger: 'webpack-infrastructure' }),
  ],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
};
