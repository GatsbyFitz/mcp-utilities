import type { NextConfig } from "next";
import { baseURL } from "./baseUrl";
import {withWorkflow} from "workflow/next"

const nextConfig: NextConfig = {
  assetPrefix: baseURL,
  devIndicators: false,
};

export default withWorkflow(nextConfig);
