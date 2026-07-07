'use client';

import { JSX, useEffect } from "react";

export function ReactScan (): JSX.Element {
	useEffect(() => {
		if (process.env.NEXT_PUBLIC_DISABLE_REACT_SCAN) {
			return;
		}

		void import("react-scan").then(({ scan }) => {
			scan({
				enabled: true,
				showNotificationCount: false,
			});
		});
	}, []);

	return <></>;
}
