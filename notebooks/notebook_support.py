"""Fixture lifecycle and chart presentation; event application and analysis stay in SQL."""

from __future__ import annotations

import os
from datetime import UTC, datetime

import matplotlib.pyplot as plt
import seaborn as sns
from IPython.display import Markdown, display

from synthetic_signins_api import SyntheticSigninsApi

SOURCE = "Source: synthetic local Graph responses · vgi-azure-signins remote 007b399 · Haybarn / VGI"


def configure(lag_minutes: int):
    if type(lag_minutes) is not int or not 0 <= lag_minutes <= 20:
        raise ValueError("LAG_MINUTES must be an integer from 0 through 20")
    if datetime.now(UTC) <= datetime(2026, 7, 4, 10, 45, tzinfo=UTC):
        raise ValueError("This historical fixture requires a clock after 4 July 2026, 10:45 UTC")
    fixture = SyntheticSigninsApi().start()
    previous = os.environ.get("NOTEBOOK_SIGNINS_FIXTURE_URL")
    os.environ["NOTEBOOK_SIGNINS_FIXTURE_URL"] = fixture.url
    return fixture, previous


def cleanup(fixture, previous):
    fixture.stop()
    if previous is None:
        os.environ.pop("NOTEBOOK_SIGNINS_FIXTURE_URL", None)
    else:
        os.environ["NOTEBOOK_SIGNINS_FIXTURE_URL"] = previous


def prose(text: str) -> None:
    display(Markdown(text))


def theme() -> None:
    sns.set_theme(
        style="whitegrid",
        rc={
            "figure.dpi": 145,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "grid.color": "#E8EDE9",
            "text.color": "#243B2F",
            "axes.labelcolor": "#405047",
            "text.parse_math": False,
            "legend.frameon": False,
        },
    )


def chart(fig, title: str, subtitle: str) -> None:
    fig.text(0.08, 0.98, title, ha="left", va="top", fontsize=17, fontweight="semibold")
    fig.text(0.08, 0.91, subtitle, ha="left", va="top", fontsize=10, color="#58685F")
    fig.tight_layout(rect=(0.02, 0.10, 1, 0.83))
    fig.text(0.08, 0.03, SOURCE, fontsize=8, color="#6C7D73")
    plt.show()
